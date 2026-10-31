# MessageScheduler

Schedule text messages once or repeat them daily, weekly, monthly, or at a custom minute interval.

## Installation

This is a Vencord userplugin and requires a [Vencord source build](https://docs.vencord.dev/installing/).

From your Vencord checkout, run:

```powershell
git clone https://github.com/ThEWoLf882-42/vencord-message-scheduler.git src/userplugins/messageScheduler
pnpm install --frozen-lockfile
pnpm build --dev
pnpm inject
```

Restart Discord completely, then enable **MessageScheduler** in **User Settings → Vencord → Plugins**.

## Usage

Select the clock button in a channel's chat bar or run `/schedule`. Choose a future time, review your message, and save it. The **Your queue** tab lets you edit, pause, cancel, or reschedule messages. The manager is also available in the plugin settings.

Discord must stay open, connected, and signed in to the account that created the message. Times follow your device's timezone. Messages and sent history are stored locally on this device.

Messages more than one minute late stop for review by default; adjust the grace period in settings. Failed or interrupted deliveries are never automatically retried. Check the channel before rescheduling an uncertain delivery. Missed recurring schedules stop until you reschedule them.

Monthly schedules clamp the chosen day to the end of shorter months. Daily and weekly schedules follow the local clock, and custom intervals use elapsed minutes. The queue is checked every five seconds, with one delivery per check.

This plugin supports text and links. Attachments, stickers, polls, and replies are not captured. Mention notifications are disabled by default and can be enabled per message. Saved messages are sent directly, without applying other plugins' composer transformations.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
