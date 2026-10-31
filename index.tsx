/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { ApplicationCommandInputType } from "@api/Commands";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { formatDuration } from "@utils/text";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, DraftStore, DraftType, GuildStore, Modal, openModal, PermissionsBits, PermissionStore, React, RestAPI, SelectedChannelStore, showToast, useEffect, UserStore, useState } from "@webpack/common";

import { createScheduler, MAX_CONTENT_LENGTH, parseLocalDateTime, readQueue, Recurrence, ScheduledMessage, toLocalDateTime } from "./scheduler";

const KEY = "MessageScheduler.queue.v1";
const logger = new Logger("MessageScheduler");
const DraftActions = findByPropsLazy("clearDraft", "saveDraft");
let enabled = false;
let timer: ReturnType<typeof setInterval> | undefined;

const settings = definePluginSettings({
    paused: {
        type: OptionType.BOOLEAN,
        description: "Pause all scheduled messages. Overdue messages require rescheduling after the grace period.",
        default: false
    },
    notify: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when a message is sent, missed, or needs review.",
        default: true
    },
    gracePeriod: {
        type: OptionType.SELECT,
        description: "How late a message can be sent before it is marked as missed.",
        options: [
            { label: "1 minute", value: 1, default: true },
            { label: "5 minutes", value: 5 },
            { label: "15 minutes", value: 15 }
        ]
    }
});

const accountId = () => UserStore.getCurrentUser()?.id;

function channelLabel(channelId: string): string {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return `Channel ${channelId}`;
    if (channel.isDM()) {
        const user = UserStore.getUser(channel.recipients[0]);
        return `DM · ${user?.globalName || user?.username || channelId}`;
    }
    if (channel.isGroupDM()) return channel.name || "Group DM";
    const guild = GuildStore.getGuild(channel.guild_id);
    return `${guild?.name ? `${guild.name} / ` : ""}#${channel.name}`;
}

function checkChannel(channelId: string): void {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) throw new Error("This channel is unavailable. Open it in Discord first.");
    if (channel.guild_id) {
        const permission = channel.isThread() ? PermissionsBits.SEND_MESSAGES_IN_THREADS : PermissionsBits.SEND_MESSAGES;
        if (!PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel) || !PermissionStore.can(permission, channel))
            throw new Error("You do not have permission to send messages in this channel.");
        if (channel.isThread() && channel.threadMetadata?.locked) throw new Error("This thread is locked.");
    }
}

const scheduler = createScheduler({
    storage: {
        async read() {
            return readQueue(await DataStore.get<unknown>(KEY));
        },
        async update(mutate) {
            let result: ScheduledMessage[] = [];
            await DataStore.update<unknown>(KEY, value => {
                result = readQueue(value);
                mutate(result);
                return result;
            });
            return result;
        }
    },
    now: Date.now,
    createId: () => crypto.randomUUID(),
    accountId,
    canSend: () => enabled && !settings.store.paused && navigator.onLine,
    maxLatenessMs: () => settings.store.gracePeriod * 60_000,
    async send(message) {
        checkChannel(message.channelId);
        if (!enabled || settings.store.paused || !navigator.onLine || accountId() !== message.accountId)
            throw new Error("The active account or scheduler state changed.");
        const response = await RestAPI.post({
            url: `/channels/${message.channelId}/messages`,
            retries: 0,
            body: {
                content: message.content,
                nonce: message.nonce,
                enforce_nonce: true,
                tts: false,
                allowed_mentions: {
                    parse: message.allowMentions ? ["users", "roles", "everyone"] : [],
                    replied_user: false
                }
            }
        });
        if (!response.ok || typeof response.body?.id !== "string")
            throw new Error("Discord did not confirm delivery.");
        return response.body.id;
    },
    notify(message) {
        if (!enabled || !settings.store.notify || accountId() !== message.accountId) return;
        try {
            const sent = message.status === "sent" || message.status === "scheduled";
            showToast({
                text: sent ? `Scheduled message sent to ${message.channelLabel}` : `Scheduled message needs review: ${message.channelLabel}`,
                variant: sent ? "success" : "critical"
            });
        } catch (error) {
            logger.error("Could not show scheduler notification", error);
        }
    }
});

const repeatLabels: Record<Recurrence, string> = {
    none: "Does not repeat",
    daily: "Every day",
    weekly: "Every week",
    monthly: "Every month",
    interval: "Custom interval"
};

const formatTime = (time: number) => new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const formatCountdown = (time: number, now: number) => time <= now ? "Due now" : `Sends in ${formatDuration(Math.ceil((time - now) / 1000) * 1000, true)}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";
const initialTime = () => toLocalDateTime(Date.now() + 10 * 60_000);

const ClockIcon: IconComponent = ({ width = 24, height = 24, className }) => (
    <svg width={width} height={height} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
    </svg>
);

interface SchedulerModalProps extends RenderModalProps {
    channelId?: string;
    initialDraft: string;
    showQueue?: boolean;
}

const SchedulerModal = ErrorBoundary.wrap(function SchedulerModal(props: SchedulerModalProps) {
    const fieldId = React.useId();
    const [openedAs] = useState(accountId);
    const [tab, setTab] = useState<"compose" | "queue">(props.showQueue || !props.channelId ? "queue" : "compose");
    const [messages, setMessages] = useState<ScheduledMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [working, setWorking] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [editing, setEditing] = useState<string>();
    const [channelId, setChannelId] = useState(props.channelId ?? "");
    const [content, setContent] = useState(props.initialDraft);
    const [time, setTime] = useState(initialTime);
    const [recurrence, setRecurrence] = useState<Recurrence>("none");
    const [interval, setIntervalValue] = useState("60");
    const [allowMentions, setAllowMentions] = useState(false);
    const [filter, setFilter] = useState("active");
    const [now, setNow] = useState(Date.now);
    const switchedAccount = openedAs !== accountId();
    const activeCount = messages.filter(item => !["sent"].includes(item.status)).length;

    async function refresh() {
        try {
            setMessages(await scheduler.list());
        } catch (error) {
            setError(errorText(error));
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        void refresh();
        const refreshTimer = setInterval(() => void refresh(), 3000);
        return () => clearInterval(refreshTimer);
    }, []);

    useEffect(() => {
        if (tab !== "queue") return;
        setNow(Date.now());
        const countdownTimer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(countdownTimer);
    }, [tab]);

    async function perform(action: () => Promise<void>) {
        setWorking(true);
        setError("");
        setNotice("");
        try {
            if (!enabled) throw new Error("Enable MessageScheduler before making changes.");
            if (openedAs !== accountId()) throw new Error("The Discord account changed. Close and reopen the scheduler.");
            await action();
            await refresh();
        } catch (error) {
            setError(errorText(error));
        } finally {
            setWorking(false);
        }
    }

    function edit(message: ScheduledMessage) {
        setEditing(message.id);
        setChannelId(message.channelId);
        setContent(message.content);
        setTime(message.scheduledAt > Date.now() ? toLocalDateTime(message.scheduledAt) : initialTime());
        setRecurrence(message.recurrence);
        setIntervalValue(String(message.intervalMinutes));
        setAllowMentions(message.allowMentions);
        setError("");
        setNotice("");
        setTab("compose");
    }

    function compose() {
        setEditing(undefined);
        setChannelId(props.channelId ?? SelectedChannelStore.getChannelId() ?? "");
        setContent("");
        setTime(initialTime());
        setRecurrence("none");
        setIntervalValue("60");
        setAllowMentions(false);
        setError("");
        setNotice("");
        setTab("compose");
    }

    async function save() {
        await perform(async () => {
            checkChannel(channelId);
            await scheduler.save({
                channelId,
                channelLabel: channelLabel(channelId),
                content,
                scheduledAt: parseLocalDateTime(time),
                recurrence,
                intervalMinutes: Number(interval),
                allowMentions
            }, editing);
            if (!editing && props.initialDraft && channelId === props.channelId
                && DraftStore.getDraft(channelId, DraftType.ChannelMessage) === props.initialDraft) {
                try {
                    DraftActions.clearDraft(channelId, DraftType.ChannelMessage);
                } catch (error) {
                    logger.error("Schedule saved, but could not clear the original draft", error);
                }
            }
            setEditing(undefined);
            setContent("");
            setNotice("Message saved. Keep Discord open and connected at the scheduled time.");
            setTab("queue");
        });
    }

    const disabled = working || switchedAccount || !enabled;
    const visibleMessages = messages.filter(item => filter === "all" || (filter === "sent" ? item.status === "sent" : item.status !== "sent"));

    return (
        <Modal
            {...props}
            size="lg"
            title="Message Scheduler"
            subtitle="A little planning. Right on time."
            actions={tab === "compose" ? [
                { text: "Cancel", variant: "secondary", onClick: () => setTab("queue"), disabled: working },
                { text: editing ? "Save changes" : "Schedule message", variant: "primary", onClick: () => void save(), disabled: disabled || !channelId || !content.trim(), loading: working }
            ] : [{ text: "Done", variant: "secondary", onClick: props.onClose }]}
        >
            <div className="vc-ms">
                <div className="vc-ms-tabs" role="tablist" aria-label="Message scheduler">
                    <button type="button" role="tab" aria-selected={tab === "compose"} aria-controls={`${fieldId}-compose`} id={`${fieldId}-compose-tab`} onClick={() => setTab("compose")} disabled={working}>Schedule</button>
                    <button type="button" role="tab" aria-selected={tab === "queue"} aria-controls={`${fieldId}-queue`} id={`${fieldId}-queue-tab`} onClick={() => setTab("queue")} disabled={working}>Your queue <span className="vc-ms-count">{activeCount}</span></button>
                </div>

                <div className="vc-ms-info">
                    <ClockIcon width={18} height={18} />
                    <span>Discord must stay open. Times use your device’s timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</span>
                </div>
                {settings.store.paused && <div className="vc-ms-warning" role="status">All sending is paused in the plugin settings.</div>}
                {switchedAccount && <div className="vc-ms-error" role="alert">Your account changed. Close and reopen this window.</div>}
                {error && <div className="vc-ms-error" role="alert">{error}</div>}
                {notice && <div className="vc-ms-success" role="status">{notice}</div>}

                {tab === "compose" ? (
                    <div className="vc-ms-form" role="tabpanel" id={`${fieldId}-compose`} aria-labelledby={`${fieldId}-compose-tab`}>
                        <div className="vc-ms-destination">
                            <span className="vc-ms-eyebrow">SEND TO</span>
                            <strong>{channelId ? channelLabel(channelId) : "Open a channel, then create a schedule."}</strong>
                        </div>
                        <label className="vc-ms-field" htmlFor={`${fieldId}-message`}>
                            <span>Message <span className="vc-ms-muted">{content.length.toLocaleString()} / {MAX_CONTENT_LENGTH.toLocaleString()}</span></span>
                            <textarea id={`${fieldId}-message`} value={content} placeholder="What would you like to say?" rows={5} maxLength={MAX_CONTENT_LENGTH} onChange={event => setContent(event.currentTarget.value)} disabled={disabled} />
                        </label>
                        <p className="vc-ms-help">Text and links only. Attachments, stickers, and reply targets are not included.</p>
                        <div className="vc-ms-fields">
                            <label className="vc-ms-field" htmlFor={`${fieldId}-time`}>
                                <span>{recurrence === "none" ? "Send at" : "First send"}</span>
                                <input type="datetime-local" id={`${fieldId}-time`} value={time} min={toLocalDateTime(Date.now())} required onChange={event => setTime(event.currentTarget.value)} disabled={disabled} />
                            </label>
                            <label className="vc-ms-field" htmlFor={`${fieldId}-repeat`}>
                                <span>Repeat</span>
                                <select id={`${fieldId}-repeat`} value={recurrence} onChange={event => setRecurrence(event.currentTarget.value as Recurrence)} disabled={disabled}>
                                    {Object.entries(repeatLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                                </select>
                            </label>
                        </div>
                        {recurrence === "interval" && (
                            <label className="vc-ms-field" htmlFor={`${fieldId}-interval`}>
                                <span>Repeat every (minutes)</span>
                                <input type="number" id={`${fieldId}-interval`} value={interval} min={1} max={525600} step={1} onChange={event => setIntervalValue(event.currentTarget.value)} disabled={disabled} />
                            </label>
                        )}
                        {recurrence === "monthly" && <p className="vc-ms-help">Uses the same day each month, or the last day in shorter months.</p>}
                        <label className="vc-ms-checkbox">
                            <input type="checkbox" checked={allowMentions} onChange={event => setAllowMentions(event.currentTarget.checked)} disabled={disabled} />
                            <span>Allow this message to notify @mentions</span>
                        </label>
                        <p className="vc-ms-help">Overdue by more than {settings.store.gracePeriod} minute(s)? The schedule stops for review, including repeating messages.</p>
                    </div>
                ) : (
                    <div role="tabpanel" id={`${fieldId}-queue`} aria-labelledby={`${fieldId}-queue-tab`}>
                        <div className="vc-ms-queue-toolbar">
                            <label className="vc-ms-sr-only" htmlFor={`${fieldId}-filter`}>Filter scheduled messages</label>
                            <select id={`${fieldId}-filter`} value={filter} onChange={event => setFilter(event.currentTarget.value)}>
                                <option value="active">Upcoming & needs review</option>
                                <option value="sent">Sent</option>
                                <option value="all">All messages</option>
                            </select>
                            <Button size="small" onClick={compose} disabled={disabled}>New message</Button>
                        </div>
                        {loading ? <p className="vc-ms-empty" role="status">Loading your queue…</p> : visibleMessages.length === 0 ? (
                            <div className="vc-ms-empty">
                                <ClockIcon width={40} height={40} />
                                <strong>{filter === "sent" ? "No sent messages yet" : "A little room for later"}</strong>
                                <p>{filter === "sent" ? "Messages you send once will appear here." : "Schedule a message and it will appear here."}</p>
                            </div>
                        ) : (
                            <ul className="vc-ms-queue">
                                {visibleMessages.map(message => (
                                    <li key={message.id} className="vc-ms-card">
                                        <div className="vc-ms-card-header">
                                            <strong>{message.channelLabel}</strong>
                                            <span className="vc-ms-status" data-status={message.status}>{message.status}</span>
                                        </div>
                                        <p className="vc-ms-message">{message.content}</p>
                                        {message.status === "scheduled" && (
                                            <p className="vc-ms-countdown">
                                                <ClockIcon width={16} height={16} />
                                                <span>{settings.store.paused ? "Sending paused" : formatCountdown(message.scheduledAt, now)}</span>
                                            </p>
                                        )}
                                        <div className="vc-ms-meta">
                                            <span>{message.status === "sent" ? "Sent" : "Scheduled"} · {formatTime(message.status === "sent" ? message.lastSentAt! : message.scheduledAt)}</span>
                                            <span>{message.recurrence === "interval" ? `Every ${message.intervalMinutes} min` : repeatLabels[message.recurrence]}</span>
                                        </div>
                                        {message.lastSentAt && message.status !== "sent" && <p className="vc-ms-help">Last sent {formatTime(message.lastSentAt)}</p>}
                                        {message.error && <p className="vc-ms-card-error">{message.error}</p>}
                                        <div className="vc-ms-card-actions">
                                            {message.status !== "sending" && <Button size="small" variant="secondary" onClick={() => edit(message)} disabled={disabled}>{["missed", "failed", "sent"].includes(message.status) ? "Reschedule" : "Edit"}</Button>}
                                            {["scheduled", "paused"].includes(message.status) && <Button size="small" variant="secondary" disabled={disabled} onClick={() => void perform(() => scheduler.setPaused(message.id, message.status !== "paused"))}>{message.status === "paused" ? "Resume" : "Pause"}</Button>}
                                            <Button size="small" variant="dangerSecondary" disabled={disabled || message.status === "sending"} onClick={() => void perform(() => scheduler.remove(message.id))}>{message.status === "sent" ? "Remove" : "Cancel"}</Button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
            </div>
        </Modal>
    );
}, { noop: false });

function openScheduler(channelId = SelectedChannelStore.getChannelId(), showQueue = false) {
    const initialDraft = channelId ? DraftStore.getDraft(channelId, DraftType.ChannelMessage) || "" : "";
    openModal(props => <SchedulerModal {...props} channelId={channelId} initialDraft={initialDraft} showQueue={showQueue} />, { modalKey: "vc-message-scheduler" });
}

const SchedulerButton = ErrorBoundary.wrap(({ isAnyChat, channel }: Parameters<ChatBarButtonFactory>[0]) => {
    if (!isAnyChat) return null;
    return (
        <ChatBarButton tooltip="Schedule a message" onClick={() => openScheduler(channel.id)} buttonProps={{ "aria-haspopup": "dialog" }}>
            <ClockIcon />
        </ChatBarButton>
    );
}, { noop: true });

function tick() {
    void scheduler.tick().catch(error => logger.error("Scheduler check failed", error));
}

export default definePlugin({
    name: "MessageScheduler",
    description: "Schedule one-time and recurring messages, with a local queue you can edit, pause, or cancel.",
    authors: [{ name: "ThEWoLf882", id: 0n }],
    tags: ["Chat", "Utility"],
    settings,
    chatBarButton: { icon: ClockIcon, render: props => <SchedulerButton {...props} /> },
    commands: [{
        name: "schedule",
        description: "Open the message scheduler and your saved queue",
        inputType: ApplicationCommandInputType.BUILT_IN,
        execute(_, { channel }) {
            openScheduler(channel.id);
        }
    }],
    toolboxActions: { "Open message scheduler": () => openScheduler(undefined, true) },
    settingsAboutComponent: ErrorBoundary.wrap(() => (
        <div className="vc-ms vc-ms-settings">
            <p>Use the clock in the chat bar or /schedule. Messages are stored on this device for the account that created them. Keep Discord open to send them.</p>
            <Button onClick={() => openScheduler(undefined, true)}>Manage scheduled messages</Button>
        </div>
    ), { noop: false }),
    start() {
        enabled = true;
        if (timer) clearInterval(timer);
        timer = setInterval(tick, 5000);
        window.addEventListener("online", tick);
        tick();
    },
    stop() {
        enabled = false;
        clearInterval(timer);
        timer = undefined;
        window.removeEventListener("online", tick);
    }
});
