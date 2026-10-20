import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
	SentinelBuiltinChannel,
	SentinelBuiltinModelDefaults,
	SentinelBuiltinModelPreset,
	SentinelModelCapabilities,
	SentinelModelCostRates,
	SentinelModelEntryView,
	SentinelModelLibraryView,
	SentinelModelRoleName,
	SentinelTestResult,
} from "../types.ts";
import { CloseIcon, DeleteIcon } from "./icons.tsx";
import { ModelRolePicker } from "./ModelRolePicker.tsx";
import {
	capabilityChips,
	hostOf,
	MODEL_API_OPTIONS,
	ModelStatusTag,
	ROLE_HINTS,
	ROLE_LABELS,
	ROLE_ORDER,
	ROLE_SHORT,
	testDetail,
	testState,
	UsageTags,
} from "./model-ui.tsx";

interface Draft {
	/** Set when editing an existing entry. */
	id?: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	modelId: string;
	/** The operator asked to drop the stored key, turning the endpoint unauthenticated. */
	clearKey: boolean;
	/** Numeric fields stay strings so an empty box can mean "not declared". */
	api: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	imageInput: boolean;
	costInput: string;
	costOutput: string;
	costCacheRead: string;
	costCacheWrite: string;
	cacheShort: string;
	cacheLong: string;
}

const EMPTY_DRAFT: Draft = {
	name: "",
	baseUrl: "",
	apiKey: "",
	modelId: "",
	clearKey: false,
	api: "openai-completions",
	contextWindow: "",
	maxTokens: "",
	reasoning: false,
	imageInput: true,
	costInput: "",
	costOutput: "",
	costCacheRead: "",
	costCacheWrite: "",
	cacheShort: "",
	cacheLong: "",
};

function draftOf(entry: SentinelModelEntryView): Draft {
	return {
		id: entry.id,
		name: entry.name,
		baseUrl: entry.baseUrl,
		apiKey: "",
		modelId: entry.modelId,
		clearKey: false,
		api: entry.api,
		contextWindow: entry.contextWindow === null ? "" : String(entry.contextWindow),
		maxTokens: entry.maxTokens === null ? "" : String(entry.maxTokens),
		reasoning: entry.reasoning,
		imageInput: entry.input.includes("image"),
		costInput: entry.cost === null ? "" : rateText(entry.cost.input),
		costOutput: entry.cost === null ? "" : rateText(entry.cost.output),
		costCacheRead: entry.cost === null ? "" : rateText(entry.cost.cacheRead),
		costCacheWrite: entry.cost === null ? "" : rateText(entry.cost.cacheWrite),
		cacheShort: entry.promptCache?.short === undefined ? "" : String(entry.promptCache.short),
		cacheLong: entry.promptCache?.long === undefined ? "" : String(entry.promptCache.long),
	};
}

function applyDefaults(draft: Draft, defaults: SentinelBuiltinModelDefaults): Draft {
	return {
		...draft,
		api: defaults.api,
		contextWindow: String(defaults.contextWindow),
		maxTokens: String(defaults.maxTokens),
		reasoning: defaults.reasoning,
		imageInput: defaults.input.includes("image"),
		costInput: rateText(defaults.cost.input),
		costOutput: rateText(defaults.cost.output),
		costCacheRead: rateText(defaults.cost.cacheRead),
		costCacheWrite: rateText(defaults.cost.cacheWrite),
		cacheShort: defaults.promptCache?.short === undefined ? "" : String(defaults.promptCache.short),
		cacheLong: defaults.promptCache?.long === undefined ? "" : String(defaults.promptCache.long),
	};
}

function parsePositive(raw: string, label: string): { value?: number; error?: string } {
	const trimmed = raw.trim();
	if (!trimmed) return {};
	const value = Number(trimmed);
	if (!Number.isInteger(value) || value <= 0) return { error: `${label}必须是正整数` };
	return { value };
}

/** Catalog rates come from per-token decimals, so 0.32 arrives as 0.3199999928474426. */
function rateText(value: number): string {
	return String(Number(value.toFixed(6)));
}

function contextText(tokens: number): string {
	return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}k`;
}

/** Trailing slashes are packaging, not identity, when matching an entry to a channel. */
function normalizeEndpoint(url: string): string {
	return url.trim().replace(/\/+$/u, "").toLowerCase();
}

/** Key reuse is scoped to a host, so a path change is not enough to invalidate it. */
function urlHost(url: string): string {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return "";
	}
}

function clearCapabilities(draft: Draft): Draft {
	return {
		...draft,
		contextWindow: "",
		maxTokens: "",
		reasoning: false,
		imageInput: true,
		costInput: "",
		costOutput: "",
		costCacheRead: "",
		costCacheWrite: "",
		cacheShort: "",
		cacheLong: "",
	};
}

function parseRate(raw: string, label: string): { value?: number; error?: string } {
	const trimmed = raw.trim();
	if (!trimmed) return { value: 0 };
	const value = Number(trimmed);
	if (!Number.isFinite(value) || value < 0) return { error: `${label}必须是不小于 0 的数字` };
	return { value };
}

/**
 * The form's capability declaration. Unlike the stored view, an empty numeric
 * box means "not declared" and clears the field; the error blocks saving instead
 * of silently dropping bad input.
 */
function capabilitiesOf(draft: Draft): { capabilities: SentinelModelCapabilities; error: string | null } {
	const context = parsePositive(draft.contextWindow, "上下文窗口");
	const output = parsePositive(draft.maxTokens, "最大输出");
	const sizeError =
		context.error ??
		output.error ??
		(context.value !== undefined && output.value !== undefined && output.value > context.value
			? "最大输出不能大于上下文窗口"
			: null);
	const hasCost = [draft.costInput, draft.costOutput, draft.costCacheRead, draft.costCacheWrite].some(
		(value) => value.trim().length > 0,
	);
	let cost: SentinelModelCostRates | undefined;
	let costError: string | null = null;
	if (hasCost) {
		const input = parseRate(draft.costInput, "输入价格");
		const outputRate = parseRate(draft.costOutput, "输出价格");
		const cacheRead = parseRate(draft.costCacheRead, "缓存读价格");
		const cacheWrite = parseRate(draft.costCacheWrite, "缓存写价格");
		costError = input.error ?? outputRate.error ?? cacheRead.error ?? cacheWrite.error ?? null;
		cost = {
			input: input.value ?? 0,
			output: outputRate.value ?? 0,
			cacheRead: cacheRead.value ?? 0,
			cacheWrite: cacheWrite.value ?? 0,
		};
	}
	const short = parsePositive(draft.cacheShort, "短期缓存时长");
	const long = parsePositive(draft.cacheLong, "长期缓存时长");
	const promptCache =
		short.value !== undefined || long.value !== undefined
			? {
					...(short.value !== undefined ? { short: short.value } : {}),
					...(long.value !== undefined ? { long: long.value } : {}),
				}
			: undefined;
	return {
		capabilities: {
			api: draft.api,
			...(context.value !== undefined ? { contextWindow: context.value } : {}),
			...(output.value !== undefined ? { maxTokens: output.value } : {}),
			reasoning: draft.reasoning,
			input: draft.imageInput ? ["text", "image"] : ["text"],
			...(cost ? { cost } : {}),
			...(promptCache ? { promptCache } : {}),
		},
		error: sizeError ?? costError ?? short.error ?? long.error ?? null,
	};
}

/**
 * 设置 → 模型: roles first, because the operator thinks in jobs, and the model
 * library is maintenance. Assignment is a small picker; changing an endpoint's
 * connection or capabilities happens in a drawer so the cockpit stays visible.
 */
export function SettingsPanel({
	library,
	onSaveEntry,
	onRemoveEntry,
	onDuplicateEntry,
	onSetRole,
	onSetReviewerAuto,
	onTestEntry,
	onLookupDefaults,
	onListChannels,
	onListChannelModels,
}: {
	library: SentinelModelLibraryView | null;
	onSaveEntry: (entry: {
		id?: string;
		name: string;
		baseUrl: string;
		apiKey: string | null;
		modelId: string;
		capabilities: SentinelModelCapabilities;
	}) => void;
	onRemoveEntry: (id: string) => void;
	onDuplicateEntry: (id: string) => void;
	onSetRole: (role: SentinelModelRoleName, target: string | null) => void;
	onSetReviewerAuto: (enabled: boolean) => void;
	onTestEntry: (id: string) => Promise<SentinelTestResult | null>;
	onLookupDefaults: (modelId: string, baseUrl: string) => Promise<SentinelBuiltinModelDefaults[] | null>;
	onListChannels: (query: string) => Promise<SentinelBuiltinChannel[] | null>;
	onListChannelModels: (provider: string) => Promise<SentinelBuiltinModelPreset[] | null>;
}) {
	const [draft, setDraft] = useState<Draft | null>(null);
	const [drawerTab, setDrawerTab] = useState<"conn" | "cap">("conn");
	const [deleteWarn, setDeleteWarn] = useState(false);
	const [pickerRole, setPickerRole] = useState<SentinelModelRoleName | null>(null);
	const [search, setSearch] = useState("");
	const [testing, setTesting] = useState<string | null>(null);
	const [testingAll, setTestingAll] = useState(false);
	/** Test results live in this component only: a stored "usable" goes stale. */
	const [results, setResults] = useState<Record<string, SentinelTestResult | null>>({});
	/** Built-in catalog suggestions for the open draft; applying is always explicit or new-entry-only. */
	const [defaultsLoading, setDefaultsLoading] = useState(false);
	const [defaultsMatches, setDefaultsMatches] = useState<SentinelBuiltinModelDefaults[] | null>(null);
	const [defaultsNote, setDefaultsNote] = useState("");
	/** `${modelId}|${baseUrl}` already looked up, so blur does not refill after manual edits. */
	const [autoLookupKey, setAutoLookupKey] = useState("");
	/** Channel list for the first picker; the query is matched on the server. */
	const [channelOptions, setChannelOptions] = useState<SentinelBuiltinChannel[] | null>(null);
	const [channelsLoading, setChannelsLoading] = useState(false);
	const [channelsError, setChannelsError] = useState("");
	const [channelSearch, setChannelSearch] = useState("");
	const [channelPickerOpen, setChannelPickerOpen] = useState(false);
	const [channel, setChannel] = useState<SentinelBuiltinChannel | null>(null);
	const [customChannel, setCustomChannel] = useState(false);
	/** Models of the chosen channel, filtered in the browser by the second picker. */
	const [models, setModels] = useState<SentinelBuiltinModelPreset[] | null>(null);
	const [modelsLoading, setModelsLoading] = useState(false);
	const [modelsError, setModelsError] = useState("");
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [modelSearch, setModelSearch] = useState("");
	const [customModel, setCustomModel] = useState(false);
	const [capsSource, setCapsSource] = useState<"catalog" | "current" | "manual" | "">("");
	/** Stale replies lose to the newer keystroke, not the other way around. */
	const channelSeqRef = useRef(0);
	const modelsSeqRef = useRef(0);
	/** The channel a pending model reply belongs to; a switch must discard it. */
	const channelRef = useRef<SentinelBuiltinChannel | null>(null);
	/** Once the operator picks a channel, loading must not override that choice. */
	const channelTouchedRef = useRef(false);
	/** An edit infers its channel from the endpoint exactly once. */
	const inferenceRef = useRef(false);
	const modelCacheRef = useRef(new Map<string, SentinelBuiltinModelPreset[]>());
	const channelBlockRef = useRef<HTMLDivElement | null>(null);
	const modelBlockRef = useRef<HTMLDivElement | null>(null);
	const customModelInputRef = useRef<HTMLInputElement | null>(null);
	/** Focus target while the drawer is open; also the element focus returns from. */
	const drawerRef = useRef<HTMLElement | null>(null);
	/** Name that came from a model, so switching models replaces it but a typed name survives. */
	const autoNameRef = useRef<string | null>(null);
	const drawerOpen = draft !== null;

	const loadChannels = async (query: string): Promise<void> => {
		const seq = ++channelSeqRef.current;
		setChannelsLoading(true);
		setChannelsError("");
		const channels = await onListChannels(query);
		if (channelSeqRef.current !== seq) return;
		setChannelsLoading(false);
		if (channels === null) {
			setChannelsError("内置渠道读取超时，请重试。");
			return;
		}
		setChannelOptions(channels);
	};

	const loadModels = async (next: SentinelBuiltinChannel): Promise<SentinelBuiltinModelPreset[] | null> => {
		const cached = modelCacheRef.current.get(next.provider);
		if (cached) {
			setModels(cached);
			setModelsLoading(false);
			setModelsError("");
			return cached;
		}
		const seq = ++modelsSeqRef.current;
		setModels(null);
		setModelsLoading(true);
		setModelsError("");
		const presets = await onListChannelModels(next.provider);
		if (modelsSeqRef.current !== seq) return null;
		setModelsLoading(false);
		if (presets === null) {
			setModelsError("模型目录读取超时，请重试。");
			return null;
		}
		modelCacheRef.current.set(next.provider, presets);
		setModels(presets);
		return presets;
	};

	useEffect(() => {
		if (!drawerOpen) return;
		const timer = window.setTimeout(() => void loadChannels(channelSearch), 220);
		return () => window.clearTimeout(timer);
	}, [channelSearch, drawerOpen]);

	/** An existing entry opens on its own channel when the endpoint matches one. */
	useEffect(() => {
		if (!drawerOpen || inferenceRef.current || channelTouchedRef.current) return;
		if (!draft?.id || !library || channelOptions === null) return;
		inferenceRef.current = true;
		const entry = library.entries.find((candidate) => candidate.id === draft.id);
		if (!entry) return;
		const wanted = normalizeEndpoint(entry.baseUrl);
		const found = wanted
			? channelOptions.find((candidate) => candidate.baseUrls.some((url) => normalizeEndpoint(url) === wanted))
			: undefined;
		// A catalog-derived name is replaced when the model changes; a typed one survives.
		if (entry.name === entry.modelId.trim()) autoNameRef.current = entry.name;
		if (!found) {
			setCustomChannel(true);
			setCapsSource("current");
			return;
		}
		channelRef.current = found;
		setChannel(found);
		setCustomChannel(false);
		setCapsSource("current");
		void loadModels(found).then((presets) => {
			if (channelRef.current?.provider !== found.provider) return;
			const preset = presets?.find((candidate) => candidate.modelId === entry.modelId.trim());
			setCustomModel(!preset);
			if (preset && entry.name === preset.name) autoNameRef.current = entry.name;
		});
	}, [channelOptions, drawerOpen]);

	/** A failed catalog must not strand the form: custom always works. */
	useEffect(() => {
		if (!drawerOpen || channelOptions !== null || !channelsError || channelTouchedRef.current) return;
		inferenceRef.current = true;
		setCustomChannel(true);
		setCapsSource(draft?.id ? "current" : "manual");
	}, [channelsError, channelOptions, drawerOpen]);

	useEffect(() => {
		if (!channelPickerOpen && !modelPickerOpen) return;
		const closeOutside = (event: MouseEvent) => {
			const target = event.target as Node;
			if (channelPickerOpen && channelBlockRef.current && !channelBlockRef.current.contains(target)) {
				setChannelPickerOpen(false);
			}
			if (modelPickerOpen && modelBlockRef.current && !modelBlockRef.current.contains(target)) {
				setModelPickerOpen(false);
			}
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setChannelPickerOpen(false);
			setModelPickerOpen(false);
		};
		document.addEventListener("mousedown", closeOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("mousedown", closeOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [channelPickerOpen, modelPickerOpen]);

	/** Move focus into the dialog and give it back to the row that opened it. */
	useEffect(() => {
		if (!drawerOpen) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		drawerRef.current?.focus();
		return () => previous?.focus();
	}, [drawerOpen]);

	useEffect(() => {
		if (!drawerOpen) return;
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// An open picker consumes Escape and closes only itself.
			if (channelPickerOpen || modelPickerOpen) return;
			closeDraft();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [drawerOpen, channelPickerOpen, modelPickerOpen]);

	if (!library) {
		return (
			<div className="settings settings--wide">
				<p className="settings-hint">正在读取模型配置…</p>
			</div>
		);
	}

	const runTest = async (id: string) => {
		setTesting(id);
		try {
			const result = await onTestEntry(id);
			setResults((current) => ({ ...current, [id]: result }));
		} finally {
			setTesting(null);
		}
	};

	const runAllTests = async () => {
		if (testingAll) return;
		setTestingAll(true);
		try {
			for (const entry of library.entries) {
				await runTest(entry.id);
			}
		} finally {
			setTestingAll(false);
		}
	};

	const resetChannelState = (): void => {
		// Invalidate every in-flight reply before the next draft can show it.
		channelSeqRef.current += 1;
		modelsSeqRef.current += 1;
		channelRef.current = null;
		channelTouchedRef.current = false;
		inferenceRef.current = false;
		autoNameRef.current = null;
		// A filtered list from the last search cannot infer this entry's channel.
		setChannelOptions(null);
		setChannel(null);
		setCustomChannel(false);
		setChannelPickerOpen(false);
		setChannelSearch("");
		setChannelsError("");
		setChannelsLoading(false);
		setModels(null);
		setModelsLoading(false);
		setModelsError("");
		setModelPickerOpen(false);
		setModelSearch("");
		setCustomModel(false);
		setCapsSource("");
	};

	const openDraft = (next: Draft): void => {
		setDraft(next);
		setDrawerTab("conn");
		setDeleteWarn(false);
		setDefaultsMatches(null);
		setDefaultsNote("");
		setAutoLookupKey("");
		resetChannelState();
	};

	const closeDraft = (): void => {
		setDraft(null);
		setDeleteWarn(false);
		setDefaultsMatches(null);
		setDefaultsNote("");
		setAutoLookupKey("");
		resetChannelState();
	};

	const lookupDefaults = async (auto: boolean, key?: string): Promise<void> => {
		if (!draft?.modelId.trim()) {
			setDefaultsNote("先填写模型 ID，再查内置库。");
			return;
		}
		const lookupKey = key ?? `${draft.modelId.trim()}|${draft.baseUrl.trim()}`;
		setDefaultsLoading(true);
		const matches = await onLookupDefaults(draft.modelId.trim(), draft.baseUrl.trim());
		setDefaultsLoading(false);
		setAutoLookupKey(lookupKey);
		const found = matches ?? [];
		if (found.length === 0) {
			setDefaultsMatches(null);
			setDefaultsNote("内置库没有同 ID 的模型，请手工填写能力。");
			return;
		}
		// A near miss is a different model. Offer it as a choice; never apply it
		// behind the operator's back, even when it is the only candidate.
		if (found.every((match) => match.approximate === true)) {
			setDefaultsMatches(found);
			setDefaultsNote("内置库没有同 ID 的模型，以下是相近条目，选择后请核对。");
			return;
		}
		setDefaultsMatches(found.length > 1 ? found : null);
		if (auto || found.length === 1) {
			const defaults = found[0];
			setDraft((current) => {
				// The operator may have typed a different model while the lookup was
				// in flight; those numbers belong to the old one.
				if (!current || `${current.modelId.trim()}|${current.baseUrl.trim()}` !== lookupKey) return current;
				return applyDefaults(current, defaults);
			});
			setDefaultsNote(`已按内置库「${defaults.providerName}」填充，可继续修改。`);
			setCapsSource("catalog");
			return;
		}
		setDefaultsNote(`找到 ${found.length} 个同 ID 模型，选一个填充。`);
	};

	/** New entries prefill once per model-id/host pair; existing entries only on request. */
	const autoFillNewEntry = (): void => {
		if (!draft || draft.id) return;
		if (!draft.modelId.trim() || !draft.baseUrl.trim()) return;
		const key = `${draft.modelId.trim()}|${draft.baseUrl.trim()}`;
		if (key === autoLookupKey) return;
		void lookupDefaults(true, key);
	};

	const applyDefaultsToDraft = (defaults: SentinelBuiltinModelDefaults): void => {
		setDraft((current) => (current ? applyDefaults(current, defaults) : current));
		setDefaultsNote(`已按内置库「${defaults.providerName}」填充，可继续修改。`);
		setCapsSource("catalog");
		setDrawerTab("cap");
	};

	/** A typed name survives a selection; one that came from a model is replaced. */
	const nameAfterSelection = (current: Draft, next: string): string => {
		const auto = current.name.trim() === "" || (autoNameRef.current !== null && current.name === autoNameRef.current);
		// A custom id has no display name to offer, so an auto name clears instead.
		autoNameRef.current = auto && next ? next : null;
		return auto ? next : current.name;
	};

	const pickBuiltinChannel = (next: SentinelBuiltinChannel): void => {
		if (!customChannel && channel?.provider === next.provider) {
			setChannelPickerOpen(false);
			setChannelSearch("");
			return;
		}
		channelTouchedRef.current = true;
		channelRef.current = next;
		setChannel(next);
		setCustomChannel(false);
		setChannelPickerOpen(false);
		setChannelSearch("");
		setModelPickerOpen(false);
		setModelSearch("");
		setModels(null);
		setModelsError("");
		setCustomModel(false);
		setCapsSource("");
		setDefaultsMatches(null);
		setDefaultsNote("");
		setAutoLookupKey("");
		if (draft) {
			// The model and every capability belonged to the previous channel.
			setDraft({
				...clearCapabilities(draft),
				modelId: "",
				apiKey: "",
				api: next.api,
				baseUrl: next.baseUrl,
				name: nameAfterSelection(draft, ""),
			});
		}
		void loadModels(next).then((presets) => {
			if (channelRef.current?.provider !== next.provider) return;
			if (presets === null) return;
			if (presets.length === 0) {
				setCustomModel(true);
				window.setTimeout(() => customModelInputRef.current?.focus(), 0);
				return;
			}
			// Continue the flow: the second picker is the next step.
			setModelPickerOpen(true);
		});
	};

	const pickCustomChannel = (): void => {
		channelTouchedRef.current = true;
		if (customChannel) {
			setChannelPickerOpen(false);
			setChannelSearch("");
			return;
		}
		const previous = channelRef.current;
		channelRef.current = null;
		setChannel(null);
		setCustomChannel(true);
		setChannelPickerOpen(false);
		setChannelSearch("");
		setModelPickerOpen(false);
		setModelSearch("");
		setModels(null);
		setModelsError("");
		setCustomModel(false);
		setCapsSource("manual");
		setDefaultsMatches(null);
		setDefaultsNote("");
		setAutoLookupKey("");
		if (draft) {
			// Carry the current endpoint over: a relay usually overrides one vendor.
			setDraft({
				...draft,
				baseUrl: draft.baseUrl.trim() ? draft.baseUrl : (previous?.baseUrl ?? ""),
				api: previous?.api ?? draft.api,
			});
		}
	};

	const pickModel = (preset: SentinelBuiltinModelPreset): void => {
		if (!draft) return;
		setDraft({
			...applyDefaults(draft, preset),
			modelId: preset.modelId,
			baseUrl: preset.baseUrl,
			name: nameAfterSelection(draft, preset.name),
		});
		setCustomModel(false);
		setModelPickerOpen(false);
		setModelSearch("");
		setCapsSource("catalog");
		setDefaultsMatches(null);
		setDefaultsNote("");
		setAutoLookupKey(`${preset.modelId}|${preset.baseUrl.trim()}`);
	};

	const pickCustomModel = (): void => {
		if (customModel) {
			setModelPickerOpen(false);
			window.setTimeout(() => customModelInputRef.current?.focus(), 0);
			return;
		}
		setCustomModel(true);
		setModelPickerOpen(false);
		setModelSearch("");
		setCapsSource("manual");
		setDefaultsMatches(null);
		setDefaultsNote("");
		setAutoLookupKey("");
		if (draft) {
			setDraft({ ...clearCapabilities(draft), modelId: "", name: nameAfterSelection(draft, "") });
		}
		window.setTimeout(() => customModelInputRef.current?.focus(), 0);
	};

	const retryModels = (): void => {
		if (channel) void loadModels(channel);
	};

	const draftId = draft?.id ?? null;
	const editingEntry = draftId ? (library.entries.find((entry) => entry.id === draftId) ?? null) : null;
	const entryHost = editingEntry ? urlHost(editingEntry.baseUrl) : "";
	const draftHost = draft ? urlHost(draft.baseUrl) : "";
	const keyHostChanged = Boolean(draft?.id) && entryHost !== "" && draftHost !== "" && entryHost !== draftHost;

	const submit = (): void => {
		if (!draft) return;
		const parsed = capabilitiesOf(draft);
		if (parsed.error) return;
		// Editing: an untouched key field means "keep what is stored". A changed
		// host must not receive the old key, so an empty field clears it instead.
		// Adding: an empty key means the endpoint needs no authentication.
		const apiKey = draft.clearKey
			? ""
			: draft.apiKey.trim()
				? draft.apiKey.trim()
				: draft.id
					? keyHostChanged
						? ""
						: null
					: "";
		onSaveEntry({
			...(draft.id ? { id: draft.id } : {}),
			name: draft.name,
			baseUrl: draft.baseUrl,
			modelId: draft.modelId,
			apiKey,
			capabilities: parsed.capabilities,
		});
		closeDraft();
	};

	const removeDraftEntry = (entry: SentinelModelEntryView): void => {
		if (entry.roles.length > 0) {
			setDeleteWarn(true);
			return;
		}
		onRemoveEntry(entry.id);
		closeDraft();
	};

	const keyword = search.trim().toLowerCase();
	const shown = library.entries.filter((entry) =>
		`${entry.name} ${entry.modelId} ${entry.baseUrl}`.toLowerCase().includes(keyword),
	);
	const unused = library.entries.filter((entry) => entry.roles.length === 0).length;
	const assigned = ROLE_ORDER.filter((role) => library.resolved[role] !== null).length;
	const capabilityError = draft ? capabilitiesOf(draft).error : null;
	const valid =
		draft !== null &&
		draft.baseUrl.trim().length > 0 &&
		draft.modelId.trim().length > 0 &&
		capabilityError === null;

	const modelOptions = models ?? [];
	const modelTokens = modelSearch.trim().toLowerCase().split(/\s+/u).filter(Boolean);
	const visibleModels = modelOptions.filter((preset) => {
		if (modelTokens.length === 0) return true;
		const haystack = `${preset.name} ${preset.modelId}`.toLowerCase();
		return modelTokens.every((token) => haystack.includes(token));
	});
	const selectedModel =
		!customChannel && !customModel && draft?.modelId.trim()
			? (modelOptions.find((preset) => preset.modelId === draft.modelId.trim()) ?? null)
			: null;
	const channelItems = channelOptions ?? [];
	const featuredChannels = channelItems.filter((option) => option.featured);
	const moreChannels = channelItems.filter((option) => !option.featured);
	const capsSourceLabel =
		capsSource === "catalog"
			? "来源：pi 内置目录"
			: capsSource === "current"
				? "当前配置"
				: capsSource === "manual"
					? "需手动填写"
					: "选择模型后自动填入";
	const contextValue = draft?.contextWindow.trim() ?? "";
	const contextTokens = Number(contextValue);
	const capContext = contextValue && Number.isFinite(contextTokens) ? contextText(contextTokens) : "—";
	const outputValue = draft?.maxTokens.trim() ?? "";
	const outputTokens = Number(outputValue);
	const capOutput = outputValue && Number.isFinite(outputTokens) ? contextText(outputTokens) : "—";
	const hasPrice = Boolean(draft && (draft.costInput.trim() || draft.costOutput.trim()));
	const capPrice = hasPrice ? `$${draft?.costInput.trim() || "0"} / $${draft?.costOutput.trim() || "0"}` : "—";
	/** null means the probe produced no result at all; undefined means "not tested yet". */
	const drawerTest = editingEntry ? results[editingEntry.id] : undefined;

	const drawerWarn =
		deleteWarn && editingEntry && editingEntry.roles.length > 0 ? (
			<div className="cockpit-warn">
				该模型仍被 {editingEntry.roles.map((role) => ROLE_LABELS[role]).join("、")} 使用，先解除引用才能删除。
				<div className="cockpit-warn__actions">
					<button
						type="button"
						className="cockpit-mini-btn"
						onClick={() => {
							const role = editingEntry.roles[0];
							closeDraft();
							setPickerRole(role);
						}}
					>
						去更换「{ROLE_LABELS[editingEntry.roles[0]]}」
					</button>
					<button type="button" className="cockpit-link" onClick={() => setDeleteWarn(false)}>
						取消
					</button>
				</div>
			</div>
		) : null;

	const keyField = () => (
		<div className="cockpit-field">
			<span>{customChannel ? "API Key" : `${channel?.name ?? ""} API Key`}</span>
			<input
				value={draft?.apiKey ?? ""}
				onChange={(event) =>
					setDraft((current) =>
						current ? { ...current, apiKey: event.target.value, clearKey: false } : current,
					)
				}
				placeholder={draft?.id ? "已保存，留空表示不修改" : "无鉴权端点留空"}
				type="password"
				spellCheck={false}
			/>
			{draft?.id && editingEntry?.hasKey ? (
				<label className="cockpit-check">
					<input
						type="checkbox"
						checked={draft.clearKey}
						onChange={(event) =>
							setDraft((current) =>
								current ? { ...current, clearKey: event.target.checked, apiKey: "" } : current,
							)
						}
					/>
					<span>清除已保存的密钥（改成无鉴权端点）</span>
				</label>
			) : null}
			{keyHostChanged && !draft?.apiKey.trim() && !draft?.clearKey ? (
				<small className="cockpit-hint">端点主机已变化；不填新 Key 时，保存会清除旧密钥。</small>
			) : null}
		</div>
	);

	const lookupPanel = () => (
		<div className="cockpit-lookup">
			<div className="cockpit-lookup__head">
				<span>按模型 ID 查内置库</span>
				<button
					type="button"
					className="cockpit-link"
					disabled={defaultsLoading || !draft?.modelId.trim()}
					onClick={() => void lookupDefaults(false)}
				>
					{defaultsLoading ? "查询中…" : "填充能力"}
				</button>
			</div>
			<p className="cockpit-hint">{defaultsNote || "ID 匹配时自动补上下文、价格等能力，不改端点。"}</p>
			{defaultsMatches ? (
				<div className="cockpit-lookup__matches">
					{defaultsMatches.map((defaults) => (
						<button
							type="button"
							key={defaults.provider}
							onClick={() => applyDefaultsToDraft(defaults)}
						>
							{defaults.providerName} · {defaults.modelId} · {defaults.api}
						</button>
					))}
				</div>
			) : null}
		</div>
	);

	const capabilityCard = () => (
		<div className="cockpit-caps-card">
			<div className="cockpit-caps-card__head">
				<span>能力概览</span>
				<span className="cockpit-caps-card__src">{capsSourceLabel}</span>
			</div>
			<div className="cockpit-caps-card__chips">
				<span className="cockpit-cap">
					<i>上下文</i>
					<b>{capContext}</b>
				</span>
				<span className="cockpit-cap">
					<i>输出</i>
					<b>{capOutput}</b>
				</span>
				<span className="cockpit-cap">
					<i>思考</i>
					<b>{draft?.reasoning ? "✓" : "—"}</b>
				</span>
				<span className="cockpit-cap">
					<i>图片</i>
					<b>{draft?.imageInput ? "✓" : "—"}</b>
				</span>
				<span className="cockpit-cap">
					<i>价格</i>
					<b>{capPrice}</b>
				</span>
			</div>
			<p className="cockpit-hint">
				{customChannel
					? "自定义渠道的能力沿用当前填写，请自行核对。"
					: "端点与协议跟随渠道；能力可在「能力与价格」里改。"}
			</p>
		</div>
	);

	return (
		<div className="settings settings--wide cockpit">
			<div className="cockpit-sec cockpit-sec--first">
				<h3>角色</h3>
				<span className="cockpit-sec__meta">
					{assigned} / {ROLE_ORDER.length} 已分配 · 点击「更换」选择模型
				</span>
				<span className="cockpit-sec__right">
					<button
						type="button"
						className="cockpit-link"
						disabled={testingAll || library.entries.length === 0}
						onClick={() => void runAllTests()}
					>
						{testingAll ? "测试中…" : "全部测试"}
					</button>
				</span>
			</div>
			<div className="cockpit-roles">
				{ROLE_ORDER.map((role) => {
					const resolved = library.resolved[role];
					const roleRef = role === "main" ? library.roles.main : library.roles[role];
					const entry =
						library.entries.find((candidate) => candidate.id === (resolved?.entryId ?? roleRef)) ?? null;
					const state = testState(testing === entry?.id, entry ? results[entry.id] : undefined);
					return (
						<div className="cockpit-role" key={role}>
							<div className="cockpit-role__top">
								<span className={`cockpit-role__label is-${role}`}>{ROLE_LABELS[role]}</span>
								{entry ? (
									<ModelStatusTag state={state} detail={testDetail(results[entry.id])} />
								) : (
									<span className="cockpit-tag is-muted">未绑定</span>
								)}
							</div>
							<div className="cockpit-role__name" title={resolved?.modelId ?? ""}>
								{entry?.name ?? "未选择模型"}
							</div>
							<div className="cockpit-role__sub" title={entry?.baseUrl ?? ROLE_HINTS[role]}>
								{entry ? `${entry.modelId} · ${hostOf(entry.baseUrl)}` : ROLE_HINTS[role]}
							</div>
							<div className="cockpit-chips">
								{entry ? (
									capabilityChips(entry).map((chip) => (
										<span className="cockpit-chip" key={chip}>
											{chip}
										</span>
									))
								) : (
									<span className="cockpit-chip">尚未解析到可用端点</span>
								)}
							</div>
							{role === "reviewer" ? (
								<label className="cockpit-check">
									<input
										type="checkbox"
										checked={library.reviewerAuto}
										onChange={(event) => onSetReviewerAuto(event.target.checked)}
									/>
									<span>
										自动评审
										<small>关闭后新记录不再排队，已排队的也会停止</small>
									</span>
								</label>
							) : null}
							<div className="cockpit-role__foot">
								<button type="button" className="cockpit-link" onClick={() => setPickerRole(role)}>
									更换
								</button>
								{entry ? (
									<button
										type="button"
										className="cockpit-link"
										disabled={testing === entry.id}
										onClick={() => void runTest(entry.id)}
									>
										测试
									</button>
								) : null}
								<span className="cockpit-role__short">
									{resolved?.followedMain ? "跟随主模型" : ROLE_SHORT[role]}
								</span>
							</div>
						</div>
					);
				})}
			</div>

			<div className="cockpit-sec">
				<h3>模型库</h3>
				<span className="cockpit-sec__meta">
					{library.entries.length} 个模型 · {unused === 0 ? "全部已使用" : `${unused} 个未使用`}
					{keyword ? ` · 匹配 ${shown.length} 个` : ""}
				</span>
				<span className="cockpit-sec__right">
					<label className="cockpit-search">
						<input
							type="search"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="搜索名称、模型 ID、端点"
							spellCheck={false}
						/>
					</label>
					<button type="button" className="primary" onClick={() => openDraft({ ...EMPTY_DRAFT })}>
						添加模型
					</button>
				</span>
			</div>
			{library.entries.length === 0 ? (
				<div className="cockpit-empty">
					还没有模型。添加一条后，角色里就能分配它。
					<button type="button" className="primary" onClick={() => openDraft({ ...EMPTY_DRAFT })}>
						添加模型
					</button>
				</div>
			) : (
				<div className="cockpit-list">
					{shown.length === 0 ? (
						<div className="cockpit-empty">没有匹配的模型，换个关键词试试</div>
					) : (
						shown.map((entry) => (
							<button
								type="button"
								className="cockpit-row"
								key={entry.id}
								onClick={() => openDraft(draftOf(entry))}
							>
								<span className="cockpit-row__name">
									<i className={`cockpit-dot is-${testState(testing === entry.id, results[entry.id]).tone}`} />
									<span className="cockpit-row__label">
										<b>{entry.name}</b>
										<small>{entry.modelId}</small>
									</span>
								</span>
								<span className="cockpit-mono cockpit-row__endpoint" title={entry.baseUrl}>
									{hostOf(entry.baseUrl)}
								</span>
								<span className="cockpit-chips cockpit-row__caps">
									{capabilityChips(entry).map((chip) => (
										<span className="cockpit-chip" key={chip}>
											{chip}
										</span>
									))}
								</span>
								<span className="cockpit-row__uses">
									<UsageTags roles={entry.roles} />
								</span>
								<span className="cockpit-row__state">
									<ModelStatusTag
										state={testState(testing === entry.id, results[entry.id])}
										detail={testDetail(results[entry.id])}
									/>
								</span>
								<span className="cockpit-chev">›</span>
							</button>
						))
					)}
				</div>
			)}

			{pickerRole ? (
				<ModelRolePicker
					key={pickerRole}
					library={library}
					role={pickerRole}
					results={results}
					onApply={(target) => {
						onSetRole(pickerRole, target);
						setPickerRole(null);
					}}
					onClose={() => setPickerRole(null)}
				/>
			) : null}

			{draft
				? createPortal(
						<>
							<button
								type="button"
								className="cockpit-scrim cockpit-scrim--drawer"
								aria-label="关闭编辑"
								onClick={closeDraft}
							/>
							<aside
								className="cockpit-drawer"
								role="dialog"
								aria-modal="true"
								aria-label="模型编辑"
								ref={drawerRef}
								tabIndex={-1}
							>
								<div className="cockpit-drawer__head">
									<div>
										<h3 className="cockpit-drawer__title">
											{draft.id ? draft.name || draft.modelId || "编辑模型" : "添加模型"}
											{editingEntry ? (
												<ModelStatusTag
													state={testState(testing === editingEntry.id, results[editingEntry.id])}
													detail={testDetail(results[editingEntry.id])}
												/>
											) : (
												<span className="cockpit-tag">未保存</span>
											)}
										</h3>
										<p className="cockpit-drawer__sub">
											{draft.id
												? `${draft.modelId || "未填写模型 ID"} · ${hostOf(draft.baseUrl) || "未填写端点"}`
												: "填写连接信息后保存"}
										</p>
									</div>
									<button
										type="button"
										className="cockpit-iconbtn"
										aria-label="关闭"
										onClick={closeDraft}
									>
										<CloseIcon />
									</button>
								</div>
								<div className="cockpit-drawer__tabs" role="tablist">
									<button
										type="button"
										role="tab"
										aria-selected={drawerTab === "conn"}
										className={drawerTab === "conn" ? "is-active" : ""}
										onClick={() => setDrawerTab("conn")}
									>
										连接
									</button>
									<button
										type="button"
										role="tab"
										aria-selected={drawerTab === "cap"}
										className={drawerTab === "cap" ? "is-active" : ""}
										onClick={() => setDrawerTab("cap")}
									>
										能力与价格
									</button>
								</div>
								{drawerTest === null ? (
									<div className="cockpit-testbar is-bad" role="status">
										<b>无响应</b>
										<span>没有收到测试结果，请重试。</span>
									</div>
								) : drawerTest ? (
									<div
										className={`cockpit-testbar ${drawerTest.ok ? "is-ok" : "is-bad"}`}
										role="status"
									>
										<b>{drawerTest.ok ? "连接可用" : "连接失败"}</b>
										<span>{drawerTest.message}</span>
										{drawerTest.detail ? (
											<small title={drawerTest.detail}>{drawerTest.detail}</small>
										) : null}
									</div>
								) : null}
								<div
									className="cockpit-drawer__body"
									role="tabpanel"
									hidden={drawerTab !== "conn"}
								>
									{capabilityError ? <p className="warn-text">{capabilityError}</p> : null}
									<div className="cockpit-field" ref={channelBlockRef}>
										<span>渠道</span>
										<button
											type="button"
											className={`cockpit-select${channelPickerOpen ? " is-open" : ""}`}
											aria-expanded={channelPickerOpen}
											onClick={() => {
												setChannelPickerOpen((open) => !open);
												setModelPickerOpen(false);
											}}
										>
											<span className="cockpit-select__main">
												<b>
													{customChannel
														? "自定义渠道"
														: channel
															? channel.name
															: channelsLoading
																? "读取渠道…"
																: "选择渠道"}
												</b>
												<em>
													{customChannel
														? "自己填 Base URL 与协议"
														: channel
															? hostOf(channel.baseUrl) || `${channel.modelCount} 个模型`
															: "从内置目录选择，或自定义"}
												</em>
											</span>
											<span className="cockpit-select__chev">▾</span>
										</button>
										<small className="cockpit-hint">
											{customChannel
												? "Key 只作用于这个端点；模型能力在「能力与价格」里填写。"
												: channel
													? `${channel.api} · ${channel.baseUrl || "端点由模型决定"}`
													: "渠道决定端点、协议与 Key 的作用域。"}
										</small>
										{channelPickerOpen ? (
											<div className="cockpit-picker">
												<div className="cockpit-picker__search">
													<input
														type="search"
														value={channelSearch}
														onChange={(event) => setChannelSearch(event.target.value)}
														placeholder="搜索渠道或模型，例如 deepseek / claude"
														spellCheck={false}
														autoFocus
													/>
													{channelsLoading ? (
														<span className="cockpit-picker__state">读取中…</span>
													) : null}
												</div>
												<div className="cockpit-picker__scroll">
													{channelsError ? (
														<div className="cockpit-picker__empty">
															{channelsError}
															<button
																type="button"
																className="cockpit-link"
																onClick={() => void loadChannels(channelSearch)}
															>
																重试
															</button>
														</div>
													) : null}
													{!channelsError &&
													!channelsLoading &&
													channelOptions !== null &&
													channelItems.length === 0 ? (
														<div className="cockpit-picker__empty">
															没有匹配的渠道，可以直接自定义。
														</div>
													) : null}
													{featuredChannels.length > 0 ? (
														<>
															<div className="cockpit-picker__group">常用渠道</div>
															{featuredChannels.map((option) => {
																const active =
																	!customChannel &&
																	channel?.provider === option.provider;
																return (
																	<button
																		type="button"
																		className={`cockpit-picker__row${active ? " is-active" : ""}`}
																		key={option.provider}
																		onClick={() => pickBuiltinChannel(option)}
																	>
																		<span className="cockpit-picker__main">
																			<b>{option.name}</b>
																			<em>
																				{hostOf(option.baseUrl) || "端点由模型决定"} ·{" "}
																				{option.modelCount} 个模型
																			</em>
																		</span>
																		{active ? (
																			<span className="cockpit-picker__check">✓</span>
																		) : null}
																	</button>
																);
															})}
														</>
													) : null}
													{moreChannels.length > 0 ? (
														<>
															<div className="cockpit-picker__group">更多渠道</div>
															{moreChannels.map((option) => {
																const active =
																	!customChannel &&
																	channel?.provider === option.provider;
																return (
																	<button
																		type="button"
																		className={`cockpit-picker__row${active ? " is-active" : ""}`}
																		key={option.provider}
																		onClick={() => pickBuiltinChannel(option)}
																	>
																		<span className="cockpit-picker__main">
																			<b>{option.name}</b>
																			<em>
																				{hostOf(option.baseUrl) || "端点由模型决定"} ·{" "}
																				{option.modelCount} 个模型
																			</em>
																		</span>
																		{active ? (
																			<span className="cockpit-picker__check">✓</span>
																		) : null}
																	</button>
																);
															})}
														</>
													) : null}
												</div>
												<div className="cockpit-picker__foot">
													<button
														type="button"
														className={`cockpit-picker__row${customChannel ? " is-active" : ""}`}
														onClick={pickCustomChannel}
													>
														<span className="cockpit-picker__main">
															<b>自定义渠道</b>
															<em>自己填 Base URL、协议与模型 ID</em>
														</span>
														{customChannel ? (
															<span className="cockpit-picker__check">✓</span>
														) : null}
													</button>
												</div>
											</div>
										) : null}
									</div>

									{customChannel ? (
										<>
											<label className="cockpit-field">
												<span>Base URL</span>
												<input
													value={draft.baseUrl}
													onChange={(event) =>
														setDraft({ ...draft, baseUrl: event.target.value })
													}
													onBlur={autoFillNewEntry}
													placeholder="https://relay.example.com/v1"
													spellCheck={false}
												/>
											</label>
											<label className="cockpit-field">
												<span>协议</span>
												<select
													value={draft.api}
													onChange={(event) =>
														setDraft({ ...draft, api: event.target.value })
													}
												>
													{MODEL_API_OPTIONS.map((option) => (
														<option value={option.id} key={option.id}>
															{option.label}
														</option>
													))}
													{MODEL_API_OPTIONS.some(
														(option) => option.id === draft.api,
													) ? null : (
														<option value={draft.api}>{draft.api}（当前值）</option>
													)}
												</select>
											</label>
											<label className="cockpit-field">
												<span>模型 ID</span>
												<input
													value={draft.modelId}
													onChange={(event) =>
														setDraft({ ...draft, modelId: event.target.value })
													}
													onBlur={autoFillNewEntry}
													placeholder="deepseek-chat / glm-4.7 / qwen3-coder…"
													spellCheck={false}
												/>
											</label>
											{lookupPanel()}
											{keyField()}
											<label className="cockpit-field">
												<span>显示名称</span>
												<input
													value={draft.name}
													onChange={(event) =>
														setDraft({ ...draft, name: event.target.value })
													}
													placeholder="默认使用模型 ID"
													spellCheck={false}
												/>
											</label>
											{capabilityCard()}
										</>
									) : channel ? (
										<>
											{keyField()}
											<div className="cockpit-field" ref={modelBlockRef}>
												<span>模型</span>
												<button
													type="button"
													className={`cockpit-select${modelPickerOpen ? " is-open" : ""}`}
													aria-expanded={modelPickerOpen}
													disabled={modelsLoading}
													onClick={() => {
														setModelPickerOpen((open) => !open);
														setChannelPickerOpen(false);
													}}
												>
													<span className="cockpit-select__main">
														<b>
															{modelsLoading
																? "读取模型…"
																: customModel
																	? "自定义模型 ID"
																	: selectedModel
																		? selectedModel.name
																		: "选择模型"}
														</b>
														<em>
															{customModel
																? draft.modelId.trim() ||
																	"目录里没有的模型"
																: selectedModel
																	? selectedModel.modelId
																	: `${modelOptions.length} 个模型`}
														</em>
													</span>
													{selectedModel ? (
														<span className="cockpit-select__meta">
															{contextText(selectedModel.contextWindow)}
														</span>
													) : null}
													<span className="cockpit-select__chev">▾</span>
												</button>
												{modelsError ? (
													<p className="warn-text">
														{modelsError}{" "}
														<button
															type="button"
															className="cockpit-link"
															onClick={retryModels}
														>
															重试
														</button>
													</p>
												) : null}
												{modelPickerOpen ? (
													<div className="cockpit-picker">
														<div className="cockpit-picker__search">
															<input
																type="search"
																value={modelSearch}
																onChange={(event) =>
																	setModelSearch(event.target.value)
																}
																placeholder="搜索模型名称或 ID"
																spellCheck={false}
																autoFocus
															/>
															<span className="cockpit-picker__state">
																{modelTokens.length > 0
																	? `${visibleModels.length} / ${modelOptions.length}`
																	: `${modelOptions.length} 个`}
															</span>
														</div>
														<div className="cockpit-picker__scroll cockpit-picker__scroll--tall">
															{modelsLoading ? (
																<div className="cockpit-picker__empty">读取模型…</div>
															) : null}
															{!modelsError &&
															!modelsLoading &&
															modelOptions.length === 0 ? (
																<div className="cockpit-picker__empty">
																	该渠道没有内置模型，请用自定义模型 ID。
																</div>
															) : null}
															{!modelsError &&
															modelOptions.length > 0 &&
															visibleModels.length === 0 ? (
																<div className="cockpit-picker__empty">
																	没有匹配的模型，可直接自定义模型 ID。
																</div>
															) : null}
															{visibleModels.map((preset) => {
																const active =
																	!customModel &&
																	draft.modelId.trim() === preset.modelId;
																return (
																	<button
																		type="button"
																		className={`cockpit-picker__row${active ? " is-active" : ""}`}
																		key={`${preset.provider}:${preset.modelId}:${preset.baseUrl}`}
																		onClick={() => pickModel(preset)}
																	>
																		<span className="cockpit-picker__main">
																			<b>{preset.name}</b>
																			<em>{preset.modelId}</em>
																		</span>
																		<span className="cockpit-picker__meta">
																			{contextText(preset.contextWindow)}
																		</span>
																	</button>
																);
															})}
														</div>
														<div className="cockpit-picker__foot">
															<button
																type="button"
																className={`cockpit-picker__row${customModel ? " is-active" : ""}`}
																onClick={pickCustomModel}
															>
																<span className="cockpit-picker__main">
																	<b>自定义模型 ID</b>
																	<em>目录里没有的模型</em>
																</span>
																<span className="cockpit-picker__meta">＋</span>
															</button>
														</div>
													</div>
												) : null}
											</div>
											{customModel ? (
												<>
													<label className="cockpit-field">
														<span>模型 ID</span>
														<input
															ref={customModelInputRef}
															value={draft.modelId}
															onChange={(event) =>
																setDraft({ ...draft, modelId: event.target.value })
															}
															onBlur={autoFillNewEntry}
															placeholder="例如 my-finetune-001"
															spellCheck={false}
														/>
														<small className="cockpit-hint">
															内置目录没有这个模型，能力与价格需要手动填。
														</small>
													</label>
													{lookupPanel()}
												</>
											) : null}
											<label className="cockpit-field">
												<span>显示名称</span>
												<input
													value={draft.name}
													onChange={(event) =>
														setDraft({ ...draft, name: event.target.value })
													}
													placeholder="默认使用模型 ID"
													spellCheck={false}
												/>
											</label>
											{capabilityCard()}
										</>
									) : (
										<p className="cockpit-hint">
											{channelsLoading
												? "正在读取内置渠道…"
												: "先在上方选择渠道；目录之外的中转用「自定义渠道」。"}
										</p>
									)}
									<p className="cockpit-hint">保存后立即生效；正在运行的会话会在下一次请求时使用新配置。</p>
								</div>
								<div className="cockpit-drawer__body" role="tabpanel" hidden={drawerTab !== "cap"}>
									<div className="cockpit-grid2">
										<label className="cockpit-field">
											<span>上下文窗口（tokens）</span>
											<input
												type="number"
												min={1}
												step={1}
												value={draft.contextWindow}
												onChange={(event) =>
													setDraft({ ...draft, contextWindow: event.target.value })
												}
												placeholder="例如 128000"
											/>
										</label>
										<label className="cockpit-field">
											<span>最大输出（tokens）</span>
											<input
												type="number"
												min={1}
												step={1}
												value={draft.maxTokens}
												onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value })}
												placeholder="例如 16384"
											/>
										</label>
									</div>
									<div className="cockpit-checks">
										<label className="cockpit-check">
											<input
												type="checkbox"
												checked={draft.reasoning}
												onChange={(event) =>
													setDraft({ ...draft, reasoning: event.target.checked })
												}
											/>
											<span>
												支持思考 / 推理
												<small>开启后默认 medium 强度，会话里仍可调整</small>
											</span>
										</label>
										<label className="cockpit-check">
											<input
												type="checkbox"
												checked={draft.imageInput}
												onChange={(event) =>
													setDraft({ ...draft, imageInput: event.target.checked })
												}
											/>
											<span>
												支持图片输入
												<small>关闭后截图不会发给该模型</small>
											</span>
										</label>
									</div>
									<div className="cockpit-divider">价格（美元 / 百万 token）</div>
									<div className="cockpit-grid2">
										<label className="cockpit-field">
											<span>输入</span>
											<input
												type="number"
												min={0}
												step="0.01"
												value={draft.costInput}
												onChange={(event) =>
													setDraft({ ...draft, costInput: event.target.value })
												}
												placeholder="0"
											/>
										</label>
										<label className="cockpit-field">
											<span>输出</span>
											<input
												type="number"
												min={0}
												step="0.01"
												value={draft.costOutput}
												onChange={(event) =>
													setDraft({ ...draft, costOutput: event.target.value })
												}
												placeholder="0"
											/>
										</label>
										<label className="cockpit-field">
											<span>缓存读</span>
											<input
												type="number"
												min={0}
												step="0.01"
												value={draft.costCacheRead}
												onChange={(event) =>
													setDraft({ ...draft, costCacheRead: event.target.value })
												}
												placeholder="0"
											/>
										</label>
										<label className="cockpit-field">
											<span>缓存写</span>
											<input
												type="number"
												min={0}
												step="0.01"
												value={draft.costCacheWrite}
												onChange={(event) =>
													setDraft({ ...draft, costCacheWrite: event.target.value })
												}
												placeholder="0"
											/>
										</label>
									</div>
									<div className="cockpit-divider">提示缓存（秒）</div>
									<div className="cockpit-grid2">
										<label className="cockpit-field">
											<span>短期</span>
											<input
												type="number"
												min={1}
												step={1}
												value={draft.cacheShort}
												onChange={(event) =>
													setDraft({ ...draft, cacheShort: event.target.value })
												}
												placeholder="例如 300"
											/>
										</label>
										<label className="cockpit-field">
											<span>长期</span>
											<input
												type="number"
												min={1}
												step={1}
												value={draft.cacheLong}
												onChange={(event) =>
													setDraft({ ...draft, cacheLong: event.target.value })
												}
												placeholder="例如 3600"
											/>
										</label>
									</div>
									<p className="cockpit-hint">
										价格决定成本统计与缓存预热收益；缓存时长只在该端点确实支持 prompt
										caching 时填写。四项价格任意一项填写即整组保存，空项按 0 计。
									</p>
									{capabilityError ? <p className="warn-text">{capabilityError}</p> : null}
								</div>
								{drawerWarn ? <div className="cockpit-drawer__warn">{drawerWarn}</div> : null}
								<div className="cockpit-drawer__foot">
									{editingEntry ? (
										<button
											type="button"
											className="cockpit-link is-danger cockpit-foot-delete"
											title={
												editingEntry.roles.length > 0
													? `被 ${editingEntry.roles.length} 个角色使用，先解除引用才能删除`
													: "删除这个模型"
											}
											onClick={() => removeDraftEntry(editingEntry)}
										>
											<DeleteIcon />
											删除
										</button>
									) : null}
									<button
										type="button"
										className="cockpit-mini-btn"
										disabled={!editingEntry || testing === editingEntry?.id}
										onClick={() => {
											if (editingEntry) void runTest(editingEntry.id);
										}}
									>
										{editingEntry && testing === editingEntry.id ? "测试中…" : "测试连接"}
									</button>
									{editingEntry ? (
										<button
											type="button"
											className="cockpit-mini-btn"
											onClick={() => onDuplicateEntry(editingEntry.id)}
										>
											复制
										</button>
									) : null}
									<button type="button" className="primary" disabled={!valid} onClick={submit}>
										保存
									</button>
								</div>
							</aside>
						</>,
						document.body,
					)
				: null}
		</div>
	);
}
