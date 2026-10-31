/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type Recurrence = "none" | "daily" | "weekly" | "monthly" | "interval";
export type Status = "scheduled" | "paused" | "sending" | "sent" | "missed" | "failed";

export interface ScheduleInput {
    channelId: string;
    channelLabel: string;
    content: string;
    scheduledAt: number;
    recurrence: Recurrence;
    intervalMinutes: number;
    allowMentions: boolean;
}

export interface ScheduledMessage extends ScheduleInput {
    id: string;
    accountId: string;
    status: Status;
    createdAt: number;
    anchorDay: number;
    anchorHour: number;
    anchorMinute: number;
    nonce: string;
    sendingAt?: number;
    lastSentAt?: number;
    lastMessageId?: string;
    error?: string;
}

export interface QueueStorage {
    read(): Promise<ScheduledMessage[]>;
    // The implementation must apply this mutation atomically across windows.
    update(mutate: (queue: ScheduledMessage[]) => void): Promise<ScheduledMessage[]>;
}

export interface SchedulerPorts {
    storage: QueueStorage;
    now(): number;
    createId(): string;
    accountId(): string | undefined;
    canSend(): boolean;
    maxLatenessMs(): number;
    send(message: ScheduledMessage): Promise<string>;
    notify?(message: ScheduledMessage): void;
}

const repeats: Recurrence[] = ["none", "daily", "weekly", "monthly", "interval"];
const statuses: Status[] = ["scheduled", "paused", "sending", "sent", "missed", "failed"];
export const MAX_CONTENT_LENGTH = 2000;
export const STALLED_SEND_MS = 10 * 60_000;

export function readQueue(value: unknown): ScheduledMessage[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(item =>
        item && typeof item.id === "string" && typeof item.accountId === "string"
        && typeof item.channelId === "string" && typeof item.channelLabel === "string"
        && typeof item.content === "string" && typeof item.allowMentions === "boolean"
        && typeof item.nonce === "string" && Number.isFinite(item.scheduledAt)
        && Number.isFinite(item.createdAt) && Number.isInteger(item.anchorDay)
        && item.anchorDay >= 1 && item.anchorDay <= 31
        && Number.isInteger(item.anchorHour) && item.anchorHour >= 0 && item.anchorHour <= 23
        && Number.isInteger(item.anchorMinute) && item.anchorMinute >= 0 && item.anchorMinute <= 59
        && repeats.includes(item.recurrence) && statuses.includes(item.status)
        && Number.isInteger(item.intervalMinutes) && item.intervalMinutes >= 1
        && (item.sendingAt === undefined || Number.isFinite(item.sendingAt))
    )) throw new Error("The saved scheduler queue is invalid. It has been left untouched.");
    return value;
}

export function toLocalDateTime(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseLocalDateTime(value: string): number {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || toLocalDateTime(date.getTime()) !== value)
        throw new Error("Choose a valid local date and time. This time may fall in a daylight saving gap.");
    return date.getTime();
}

export function nextOccurrence(message: ScheduledMessage, now: number): number | undefined {
    if (message.recurrence === "none") return;
    if (message.recurrence === "interval") {
        const interval = message.intervalMinutes * 60_000;
        const steps = Math.max(1, Math.floor((now - message.scheduledAt) / interval) + 1);
        return message.scheduledAt + steps * interval;
    }

    const next = new Date(message.scheduledAt);
    if (message.recurrence === "monthly") {
        do {
            next.setDate(1);
            next.setMonth(next.getMonth() + 1);
            const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
            next.setDate(Math.min(message.anchorDay, lastDay));
            next.setHours(message.anchorHour, message.anchorMinute, 0, 0);
        } while (next.getTime() <= now);
    } else {
        do {
            next.setDate(next.getDate() + (message.recurrence === "weekly" ? 7 : 1));
            next.setHours(message.anchorHour, message.anchorMinute, 0, 0);
        } while (next.getTime() <= now);
    }
    return next.getTime();
}

export function createScheduler(ports: SchedulerPorts) {
    let busy = false;
    const { storage } = ports;

    function requireAccount(): string {
        const accountId = ports.accountId();
        if (!accountId) throw new Error("Sign in to Discord first.");
        return accountId;
    }

    async function save(input: ScheduleInput, id?: string): Promise<ScheduledMessage> {
        const accountId = requireAccount();
        if (!/^\d+$/.test(input.channelId)) throw new Error("Choose a valid channel.");
        if (!input.content.trim()) throw new Error("Write a message first.");
        if (input.content.length > MAX_CONTENT_LENGTH) throw new Error(`Messages can contain up to ${MAX_CONTENT_LENGTH} characters.`);
        if (!Number.isFinite(input.scheduledAt) || input.scheduledAt <= ports.now()) throw new Error("Choose a time in the future.");
        if (!repeats.includes(input.recurrence)) throw new Error("Choose a valid repeat option.");
        if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 525_600)
            throw new Error("The interval must be a whole number from 1 to 525600 minutes.");

        let saved: ScheduledMessage;
        await storage.update(queue => {
            const existing = id ? queue.find(item => item.id === id && item.accountId === accountId) : undefined;
            if (id && !existing) throw new Error("This schedule no longer exists.");
            if (existing?.status === "sending") throw new Error("This message is already being sent.");
            saved = {
                ...input,
                id: existing?.id ?? ports.createId(),
                accountId,
                status: "scheduled",
                createdAt: existing?.createdAt ?? ports.now(),
                anchorDay: new Date(input.scheduledAt).getDate(),
                anchorHour: new Date(input.scheduledAt).getHours(),
                anchorMinute: new Date(input.scheduledAt).getMinutes(),
                nonce: ports.createId().replaceAll("-", "").slice(0, 25),
                lastSentAt: existing?.lastSentAt,
                lastMessageId: existing?.lastMessageId
            };
            if (existing) queue[queue.indexOf(existing)] = saved;
            else queue.push(saved);
        });
        return saved!;
    }

    async function remove(id: string): Promise<void> {
        const accountId = requireAccount();
        await storage.update(queue => {
            const index = queue.findIndex(item => item.id === id && item.accountId === accountId);
            if (index < 0) return;
            if (queue[index].status === "sending") throw new Error("Wait for this message to finish sending.");
            queue.splice(index, 1);
        });
    }

    async function setPaused(id: string, paused: boolean): Promise<void> {
        const accountId = requireAccount();
        await storage.update(queue => {
            const item = queue.find(item => item.id === id && item.accountId === accountId);
            if (!item || !["scheduled", "paused"].includes(item.status)) throw new Error("This schedule cannot be paused or resumed.");
            if (!paused && item.scheduledAt <= ports.now()) throw new Error("Edit this message and choose a future time to resume it.");
            item.status = paused ? "paused" : "scheduled";
        });
    }

    async function tick(): Promise<void> {
        if (busy || !ports.canSend()) return;
        const accountId = ports.accountId();
        if (!accountId) return;
        busy = true;
        try {
            const now = ports.now();
            const queue = await storage.read();
            if (!queue.some(item => item.accountId === accountId && (
                (item.status === "scheduled" && item.scheduledAt <= now)
                || (item.status === "sending" && now - (item.sendingAt ?? 0) > STALLED_SEND_MS)
            ))) return;

            let claimed: ScheduledMessage | undefined;
            const changed: ScheduledMessage[] = [];
            await storage.update(items => {
                for (const item of items.filter(item => item.accountId === accountId).sort((a, b) => a.scheduledAt - b.scheduledAt)) {
                    if (item.status === "sending" && now - (item.sendingAt ?? 0) > STALLED_SEND_MS) {
                        item.status = "failed";
                        item.error = "Delivery could not be confirmed. Check the channel before rescheduling.";
                        changed.push({ ...item });
                    }
                    if (item.status !== "scheduled" || item.scheduledAt > now) continue;
                    if (now - item.scheduledAt > ports.maxLatenessMs()) {
                        item.status = "missed";
                        item.error = "The scheduled time passed while Discord or the scheduler was unavailable. Edit to reschedule.";
                        changed.push({ ...item });
                    } else if (!claimed) {
                        item.status = "sending";
                        item.sendingAt = now;
                        claimed = { ...item };
                    }
                }
            });
            changed.forEach(item => ports.notify?.(item));
            if (!claimed) return;
            const message: ScheduledMessage = claimed;

            // Account switches and plugin stops can happen while IndexedDB is committing.
            if (!ports.canSend() || ports.accountId() !== accountId) {
                await storage.update(items => {
                    const item = items.find(item => item.id === message.id && item.nonce === message.nonce && item.status === "sending");
                    if (item) { item.status = "scheduled"; delete item.sendingAt; }
                });
                return;
            }

            let messageId: string;
            try {
                messageId = await ports.send(message);
            } catch (error) {
                const updated = await storage.update(items => {
                    const item = items.find(item => item.id === message.id && item.nonce === message.nonce && item.status === "sending");
                    if (!item) return;
                    item.status = "failed";
                    item.error = `${error instanceof Error ? error.message : "Discord did not confirm delivery."} Check the channel before rescheduling.`;
                });
                const failed = updated.find(item => item.id === message.id);
                if (failed) ports.notify?.(failed);
                return;
            }

            // If this commit fails, keep the durable 'sending' claim: never resend automatically.
            const updated = await storage.update(items => {
                const item = items.find(item => item.id === message.id && item.nonce === message.nonce && item.status === "sending");
                if (!item) return;
                item.lastSentAt = ports.now();
                item.lastMessageId = messageId;
                const next = nextOccurrence(item, ports.now());
                item.status = next === undefined ? "sent" : "scheduled";
                if (next !== undefined) {
                    item.scheduledAt = next;
                    item.nonce = ports.createId().replaceAll("-", "").slice(0, 25);
                }
                delete item.sendingAt;
                delete item.error;
            });
            const sent = updated.find(item => item.id === message.id);
            if (sent) ports.notify?.(sent);
        } finally {
            busy = false;
        }
    }

    return {
        save,
        remove,
        setPaused,
        tick,
        async list() {
            const accountId = ports.accountId();
            const queue = await storage.read();
            if (ports.accountId() !== accountId) return [];
            return queue.filter(item => item.accountId === accountId).sort((a, b) => a.scheduledAt - b.scheduledAt);
        }
    };
}
