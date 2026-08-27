const BAR_WIDTH = 16;
const FILL = "\u2588"; // █
const EMPTY = "\u2591"; // ░
/** Clamps a fraction into [0,1]; null stays null. */
function clampFraction(fraction) {
    if (fraction === null) {
        return null;
    }
    return Math.max(0, Math.min(1, fraction));
}
/** Renders a horizontal progress bar from a remaining fraction. */
export function renderQuotaBar(fraction, width = BAR_WIDTH) {
    const clamped = clampFraction(fraction) ?? 0;
    const filled = Math.round(clamped * width);
    return FILL.repeat(filled) + EMPTY.repeat(Math.max(0, width - filled));
}
/** Formats a duration like the agy panel: "73h 5m", "2h 7m", "12m". */
export function formatQuotaDuration(seconds) {
    if (seconds === null) {
        return null;
    }
    const rounded = Math.max(0, Math.round(seconds));
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
        return `${minutes}m`;
    }
    return `${rounded}s`;
}
function remainingPercent(fraction) {
    const clamped = clampFraction(fraction);
    if (clamped === null) {
        return "?";
    }
    return `${Math.round(clamped * 100)}%`;
}
/** Masks an account email for chat display: u***@domain. */
function maskAccount(account) {
    if (!account) {
        return null;
    }
    const at = account.indexOf("@");
    if (at <= 1) {
        return account;
    }
    return `${account.slice(0, 1)}***@${account.slice(at + 1)}`;
}
function renderBucketLine(bucket) {
    const label = bucket.label || "Quota";
    if (bucket.available) {
        return `\u25B8 ${label}  [${renderQuotaBar(1)}] \u2705 available`;
    }
    const reset = formatQuotaDuration(bucket.resetsInSeconds);
    const resetText = reset ? ` \u00B7 resets in ${reset}` : "";
    return `\u25B8 ${label}  [${renderQuotaBar(bucket.remainingFraction)}] ${remainingPercent(bucket.remainingFraction)} remaining${resetText}`;
}
function renderGroup(group) {
    const lines = [`\u{1F4CA} ${group.name}`];
    if (group.models) {
        lines.push(`   \u00B7 ${group.models}`);
    }
    for (const bucket of group.buckets) {
        lines.push(renderBucketLine(bucket));
    }
    return lines.join("\n");
}
/** Renders the full quota panel as Telegram-friendly text. */
export function renderQuotaTelegram(snapshot) {
    const header = ["\u{1F4CA} Antigravity CLI quota"];
    const account = maskAccount(snapshot.account);
    if (account) {
        header.push(`   \u00B7 account ${account}`);
    }
    if (snapshot.tier) {
        header.push(`   \u00B7 tier ${snapshot.tier}`);
    }
    if (snapshot.groups.length === 0) {
        return [
            ...header,
            "",
            "No quota buckets were reported for this account.",
            "The agy /usage panel shows quota after the CLI is signed in.",
        ].join("\n");
    }
    return [...header, "", ...snapshot.groups.map(renderGroup)].join("\n");
}
