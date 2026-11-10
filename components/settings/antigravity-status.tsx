"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ANTIGRAVITY_MINIMUM_VERSION, type AntigravityStatus, type UserSettings } from "@/src/core";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

export function antigravityStatusLabel(status: AntigravityStatus | null): string {
	switch (status?.state) {
		case "not-found": return "Not found";
		case "meets-minimum": {
			const models = status.modelCount === null ? "model list unavailable" : `${status.modelCount} model${status.modelCount === 1 ? "" : "s"}`;
			return `Version ${status.version} · meets minimum · ${models}`;
		}
		case "update-required": return `Version ${status.version} · update required`;
		default: return "Version could not be checked";
	}
}

function isStatus(value: AntigravityStatus): boolean {
	return ["not-found", "meets-minimum", "update-required", "version-unchecked"].includes(value.state)
		&& value.minimumVersion === ANTIGRAVITY_MINIMUM_VERSION
		&& (value.version === null || (typeof value.version === "string" && /^\d+\.\d+\.\d+$/.test(value.version)))
		&& (value.modelCount === null || (typeof value.modelCount === "number" && Number.isSafeInteger(value.modelCount) && value.modelCount >= 0));
}

export function AntigravityInstallationStatus() {
	const [enabled, setEnabled] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<AntigravityStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const request = useRef<AbortController | null>(null);
	const settingsRead = useRef<AbortController | null>(null);
	const settingsWrite = useRef<AbortController | null>(null);

	const read = useCallback(async () => {
		settingsRead.current?.abort();
		const controller = new AbortController();
		settingsRead.current = controller;
		setLoaded(false);
		try {
			const response = await fetch("/api/settings", { cache: "no-store", signal: controller.signal });
			if (!response.ok) throw new Error("settings unavailable");
			const body = await response.json() as { settings: UserSettings | null };
			if (!controller.signal.aborted) {
				setEnabled(body.settings?.antigravity?.enabled === true);
				setLoaded(true);
				setError(null);
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not load Antigravity CLI settings.");
		}
	}, []);
	useEffect(() => {
		void read();
		return () => { settingsRead.current?.abort(); settingsWrite.current?.abort(); };
	}, [read]);
	useSettingsSaved((section) => { if (section === "antigravity") void read(); });

	const save = async (next: boolean) => {
		const controller = new AbortController();
		settingsWrite.current = controller;
		settingsRead.current?.abort();
		setSaving(true);
		setError(null);
		try {
			const response = await fetch("/api/settings/antigravity", { method: "PUT", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: next }), signal: controller.signal });
			if (!response.ok) throw new Error("settings write failed");
			const body = await response.json() as { settings: UserSettings };
			if (typeof body.settings?.antigravity?.enabled !== "boolean") throw new Error("invalid settings response");
			if (!controller.signal.aborted) {
				setEnabled(body.settings.antigravity.enabled);
				notifySettingsSaved("antigravity");
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not save Antigravity CLI settings.");
		} finally {
			if (!controller.signal.aborted) setSaving(false);
		}
	};

	const refresh = useCallback(async () => {
		if (!enabled) return;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setBusy(true);
		try {
			const response = await fetch("/api/antigravity", { cache: "no-store", signal: controller.signal, headers: { "x-learnharness-antigravity": "1" } });
			if (!response.ok) throw new Error("status unavailable");
			const value = await response.json() as AntigravityStatus;
			if (!isStatus(value)) throw new Error("invalid status");
			if (!controller.signal.aborted) {
				setStatus(value);
				// The check refreshes the CLI's model list; let the picker re-read it.
				notifySettingsSaved("antigravity");
			}
		} catch {
			if (!controller.signal.aborted) setStatus(null);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}, [enabled]);
	useEffect(() => {
		if (enabled) void refresh();
		else { request.current?.abort(); setStatus(null); setBusy(false); }
		return () => request.current?.abort();
	}, [enabled, refresh]);

	return <div className="space-y-2" data-testid="antigravity-installation">
		<div className="flex items-center gap-3">
			<span className="font-prose text-(length:--lh-prose-size) text-foreground">Antigravity CLI (agy)</span>
			<Toggle label="Antigravity CLI" checked={enabled} disabled={!loaded || saving} onChange={(next) => void save(next)} />
		</div>
		{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
		{enabled && <>
			<div className="flex flex-wrap items-center gap-3">
				<span role="status" className="text-xs text-muted-foreground">{busy ? "Checking…" : antigravityStatusLabel(status)}</span>
				<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" disabled={busy} onClick={() => void refresh()} data-testid="antigravity-check-again">Check again</Button>
			</div>
			<p className="text-xs leading-relaxed text-muted-foreground"><strong className="font-medium">Install agy and sign in with Google in your terminal, then select an Antigravity model here.</strong> LearnHarness starts it when needed—no background process required.</p>
			<p className="text-xs leading-relaxed text-muted-foreground">Checks the version and the CLI&apos;s model list—not quota. Your Antigravity plan controls billing and limits. Turns stop if the model tries one of agy&apos;s built-in tools. Requires v{ANTIGRAVITY_MINIMUM_VERSION}+. <a href="https://antigravity.google" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">Antigravity ↗</a></p>
			<p className="text-xs leading-relaxed text-muted-foreground">Verify AI claims independently—they may be inaccurate, incomplete, misleading, or outdated.</p>
		</>}
	</div>;
}
