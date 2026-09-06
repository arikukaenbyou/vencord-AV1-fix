/*
 * DisableAv1 — renderer WebRTC codec filtering for Vencord.
 *
 * IMPORTANT:
 * Discord desktop can use its native voice/video engine instead of the
 * renderer's RTCPeerConnection implementation. These hooks affect ONLY the
 * latter. A renderer plugin cannot reliably intercept native-engine SDP.
 *
 * This prevents AV1 negotiation; it does not repair an AV1 decoder. Both peers
 * must support another codec. Disabling AV1 does not guarantee that the chosen
 * fallback codec has working hardware acceleration.
 *
 * After enabling/disabling this setting, leave and rejoin the stream: changing
 * the setting does not renegotiate existing connections.
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";

const logger = new Logger("DisableAv1");

const settings = definePluginSettings({
    disableAv1Decoding: {
        type: OptionType.BOOLEAN,
        description: "Disable AV1 Decoding",
        default: true
    }
});

type MethodName =
    | "createOffer"
    | "createAnswer"
    | "setLocalDescription"
    | "setRemoteDescription";

type PeerMethod = RTCPeerConnection[MethodName];

interface InstalledPatch {
    name: MethodName;
    originalDescriptor: PropertyDescriptor;
    wrapper: PeerMethod;
}

interface HookState {
    active: boolean;
    prototype: RTCPeerConnection;
    patches: InstalledPatch[];
}

let hookState: HookState | undefined;

function shouldFilter(state: HookState): boolean {
    return state.active && settings.store.disableAv1Decoding;
}

/**
 * Filter one video media section.
 *
 * Payload type numbers are scoped to a media section, NOT to the whole SDP.
 * For example, PT 96 can mean AV1 in one section and VP8 in another.
 *
 * Also remove dependent RTX payloads. Keeping an RTX codec whose apt points
 * at a deleted codec can cause browsers to reject the entire description.
 */
function filterVideoSection(section: string[]): string[] {
    const removedPayloads = new Set<number>();

    for (const line of section) {
        // AV1 is the current name; AV1X occurs in older implementations.
        const match = /^a=rtpmap:(\d+)[ \t]+AV1(?:X)?\/90000(?:[ \t]*)$/i.exec(line);

        if (match)
            removedPayloads.add(Number(match[1]));
    }

    if (removedPayloads.size === 0)
        return section;

    const dependencies: Array<{ payload: number; associatedPayload: number; }> = [];

    for (const line of section) {
        const fmtp = /^a=fmtp:(\d+)[ \t]+(.+)$/i.exec(line);
        if (!fmtp)
            continue;

        // apt need not be the first format parameter.
        const apt = /(?:^|;)[ \t]*apt[ \t]*=[ \t]*(\d+)[ \t]*(?=;|$)/i.exec(fmtp[2]);

        if (apt) {
            dependencies.push({
                payload: Number(fmtp[1]),
                associatedPayload: Number(apt[1])
            });
        }
    }

    // Fixed-point iteration also handles chained dependencies defensively.
    let changed: boolean;
    do {
        changed = false;

        for (const { payload, associatedPayload } of dependencies) {
            if (removedPayloads.has(associatedPayload) && !removedPayloads.has(payload)) {
                removedPayloads.add(payload);
                changed = true;
            }
        }
    } while (changed);

    // m=<media> <port> <proto> <fmt> ...
    const fields = section[0].trim().split(/[ \t]+/);

    if (fields.length < 4) {
        throw new DOMException(
            "Cannot remove AV1 from a malformed video media line.",
            "OperationError"
        );
    }

    const formats = fields.slice(3).filter(format =>
        !/^\d+$/.test(format) || !removedPayloads.has(Number(format))
    );

    if (formats.length === 0) {
        // Do not fabricate a codec or emit an invalid, format-less m= line.
        // An AV1-only description cannot negotiate a fallback by subtraction.
        throw new DOMException(
            "Cannot disable AV1: a video media section has no remaining payload types.",
            "OperationError"
        );
    }

    const result = [
        [...fields.slice(0, 3), ...formats].join(" ")
    ];

    for (const line of section.slice(1)) {
        const payloadAttribute = /^a=(?:rtpmap|rtcp-fb|fmtp):(\d+)(?=[ \t]|$)/i.exec(line);

        if (payloadAttribute && removedPayloads.has(Number(payloadAttribute[1])))
            continue;

        // Wildcard feedback, such as a=rtcp-fb:* nack, is intentionally kept.
        //
        // RID restrictions can also contain a list of payload types. Avoid
        // leaving a reference to AV1 in those lists.
        const rid = /^(a=rid:[^ \t]+[ \t]+(?:send|recv)[ \t]+)(.*)$/i.exec(line);

        if (rid) {
            let ridChanged = false;

            const parameters = rid[2].split(";").map(parameter => {
                const pt = /^([ \t]*pt[ \t]*=[ \t]*)(\d+(?:[ \t]*,[ \t]*\d+)*)([ \t]*)$/i.exec(parameter);

                if (!pt)
                    return parameter;

                const original = pt[2].split(",").map(value => value.trim());
                const retained = original.filter(value =>
                    !removedPayloads.has(Number(value))
                );

                if (retained.length === original.length)
                    return parameter;

                if (retained.length === 0) {
                    // Removing the restriction would broaden the RID's meaning.
                    // Removing the RID also requires rewriting simulcast state.
                    // Reject instead of silently changing either semantic.
                    throw new DOMException(
                        "Cannot disable AV1: a RID permits only removed payload types.",
                        "OperationError"
                    );
                }

                ridChanged = true;
                return `${pt[1]}${retained.join(",")}${pt[3]}`;
            });

            if (ridChanged) {
                result.push(`${rid[1]}${parameters.join(";")}`);
                continue;
            }
        }

        result.push(line);
    }

    return result;
}

/**
 * Preserve session-level attributes, media boundaries, newline style and the
 * presence/absence of a final newline. Unchanged descriptions remain identical.
 */
function stripAv1(sdp: string): string {
    const newline = /\r\n|\n|\r/.exec(sdp)?.[0] ?? "\r\n";
    const lines = sdp.split(/\r\n|\n|\r/);
    const result: string[] = [];
    let changed = false;

    for (let index = 0; index < lines.length;) {
        if (!/^m=video[ \t]/i.test(lines[index])) {
            result.push(lines[index++]);
            continue;
        }

        let end = index + 1;
        while (end < lines.length && !/^m=/i.test(lines[end]))
            end++;

        const section = lines.slice(index, end);
        const filtered = filterVideoSection(section);

        if (filtered !== section)
            changed = true;

        result.push(...filtered);
        index = end;
    }

    return changed ? result.join(newline) : sdp;
}

function rewriteDescription(
    description: RTCSessionDescriptionInit,
    state: HookState
): RTCSessionDescriptionInit {
    if (!shouldFilter(state) || !description.sdp)
        return description;

    const sdp = stripAv1(description.sdp);

    // Never mutate a caller-owned object or assign to the read-only .sdp of an
    // RTCSessionDescription. Native setters accept a plain init dictionary.
    return sdp === description.sdp
        ? description
        : { type: description.type, sdp };
}

/**
 * Report an error in a legacy callback operation. There is no useful rejected
 * promise to return from a success callback invoked later by the browser.
 */
function reportCallbackError(callback: unknown, error: unknown): void {
    if (typeof callback === "function")
        Reflect.apply(callback, undefined, [error]);
    else
        logger.error("SDP filtering failed in a legacy WebRTC callback.", error);
}

function interceptCreate(
    original: PeerMethod,
    connection: RTCPeerConnection,
    args: unknown[],
    state: HookState
): unknown {
    // Preserve the deprecated callback overload for code that still uses it.
    if (typeof args[0] === "function") {
        const success = args[0];
        const failure = args[1];
        const forwarded = [...args];

        forwarded[0] = (description: RTCSessionDescriptionInit): void => {
            let rewritten: RTCSessionDescriptionInit;

            try {
                rewritten = rewriteDescription(description, state);
            } catch (error) {
                reportCallbackError(failure, error);
                return;
            }

            // Keep exceptions thrown by the consumer's callback separate from
            // errors raised by SDP filtering.
            Reflect.apply(success, undefined, [rewritten]);
        };

        return Reflect.apply(original, connection, forwarded);
    }

    const pending = Reflect.apply(original, connection, args) as Promise<RTCSessionDescriptionInit>;

    // Filtering generated SDP matters: applications often send the object
    // returned by createOffer/createAnswer rather than pc.localDescription.
    return pending.then(description => rewriteDescription(description, state));
}

function interceptSet(
    name: "setLocalDescription" | "setRemoteDescription",
    original: PeerMethod,
    connection: RTCPeerConnection,
    args: unknown[],
    state: HookState
): unknown {
    const input = args[0];

    // Pass malformed primitive arguments to the browser for native validation.
    const dictionary = input == null
        ? undefined
        : typeof input === "object"
            ? input as Partial<RTCSessionDescriptionInit>
            : undefined;

    try {
        if (
            name === "setLocalDescription"
            && (input == null || dictionary !== undefined)
            && (dictionary?.sdp === undefined || dictionary.sdp === "")
            && (
                dictionary?.type === undefined
                || dictionary.type === "offer"
                || dictionary.type === "answer"
            )
        ) {
            /*
             * setLocalDescription() can generate SDP internally without calling
             * the JS createOffer/createAnswer methods. Generate it explicitly so
             * that this convenience path cannot bypass filtering.
             *
             * As with any explicit create-then-set sequence, applications must
             * serialize negotiation rather than race signaling operations.
             */
            const type = dictionary?.type ?? (
                connection.signalingState === "stable"
                || connection.signalingState === "have-local-offer"
                || connection.signalingState === "have-remote-pranswer"
                    ? "offer"
                    : "answer"
            );

            const pending = type === "offer"
                ? connection.createOffer()
                : connection.createAnswer();

            return pending.then(description => {
                const forwarded = [...args];
                forwarded[0] = rewriteDescription(description, state);

                return Reflect.apply(original, connection, forwarded) as Promise<void>;
            });
        }

        const forwarded = [...args];

        if (
            dictionary
            && typeof dictionary.type === "string"
            && typeof dictionary.sdp === "string"
        ) {
            forwarded[0] = rewriteDescription(
                dictionary as RTCSessionDescriptionInit,
                state
            );
        }

        // Rollback descriptions have no SDP and pass through unchanged.
        return Reflect.apply(original, connection, forwarded);
    } catch (error) {
        // Match the asynchronous failure model of the promise-based setters.
        if (typeof args[1] === "function" && typeof args[2] === "function") {
            reportCallbackError(args[2], error);
            return Promise.resolve();
        }

        return Promise.reject(error);
    }
}

function installPatch(state: HookState, name: MethodName): void {
    const descriptor = Object.getOwnPropertyDescriptor(state.prototype, name);
    const original = state.prototype[name];

    if (!descriptor || typeof original !== "function") {
        throw new Error(`RTCPeerConnection.${name} is unavailable.`);
    }

    /*
     * Proxy preserves the native TypeScript overload surface and forwards
     * untouched calls, callback arguments and the actual receiver.
     */
    const wrapper = new Proxy(original, {
        apply(target, thisArg: RTCPeerConnection, args: unknown[]): unknown {
            if (!shouldFilter(state))
                return Reflect.apply(target, thisArg, args);

            if (name === "createOffer" || name === "createAnswer")
                return interceptCreate(target, thisArg, args, state);

            return interceptSet(name, target, thisArg, args, state);
        }
    });

    Object.defineProperty(state.prototype, name, {
        ...descriptor,
        value: wrapper
    });

    state.patches.push({
        name,
        originalDescriptor: descriptor,
        wrapper
    });
}

function uninstallPatches(state: HookState): void {
    /*
     * Disable this installation's closures first, including in-flight promises.
     * Each start gets a distinct state so old wrappers cannot reactivate later.
     */
    state.active = false;

    for (const patch of [...state.patches].reverse()) {
        const current = Object.getOwnPropertyDescriptor(state.prototype, patch.name);

        // Do not overwrite a hook installed by another plugin after ours.
        // If that hook wraps ours, our retained wrapper is now a passthrough.
        if (current?.value === patch.wrapper) {
            Object.defineProperty(
                state.prototype,
                patch.name,
                patch.originalDescriptor
            );
        }
    }

    state.patches.length = 0;
}

export default definePlugin({
    name: "DisableAv1",
    description: "Filters AV1 and associated RTX payloads from renderer WebRTC SDP. Rejoin streams after changing the setting.",
    authors: [{ name: "Local plugin", id: 0n }],
    settings,

    start() {
        if (hookState)
            return;

        if (typeof window.RTCPeerConnection !== "function") {
            logger.warn(
                "Renderer RTCPeerConnection is unavailable; native Discord video is not intercepted."
            );
            return;
        }

        const state: HookState = {
            active: true,
            prototype: window.RTCPeerConnection.prototype,
            patches: []
        };

        try {
            installPatch(state, "createOffer");
            installPatch(state, "createAnswer");
            installPatch(state, "setLocalDescription");
            installPatch(state, "setRemoteDescription");

            hookState = state;
        } catch (error) {
            // Never leave a partially installed set of hooks behind.
            uninstallPatches(state);
            throw error;
        }
    },

    stop() {
        const state = hookState;
        hookState = undefined;

        if (state)
            uninstallPatches(state);
    }
});
