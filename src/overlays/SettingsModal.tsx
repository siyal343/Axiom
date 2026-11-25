import { useEffect, useState } from "preact/hooks";
import {
  ACTION_TAGS,
  BUILTIN_LENS_PRESETS,
  customLensesSignal,
  setCustomLenses,
} from "../input/actionTags";
import {
  getSettings,
  isTauriRuntime,
  parseIpcError,
  saveFlowSystemPrompt,
  saveSettings,
  testProviderConnection,
} from "../ipc/client";
import type {
  AppSettingsDto,
  CustomLensDef,
  EdgeType,
  ModelTierConfig,
  NodeType,
  ProviderKind,
  SaveSettingsInput,
  Severity,
  TestConnectionResult,
} from "../ipc/types";
import { closeSettingsModal, settingsModalOpen } from "../store/aiRunner";
import { flowSystemPrompt, setTheme, theme, tokenBudget } from "../store/graphStore";
import { modalState } from "../store/selection";
import { pushToast } from "./ToastStack";

const DEFAULT_SETTINGS: AppSettingsDto = {
  reasoning: {
    provider: "openai_compat",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o",
    has_api_key: false,
    temperature: 0.4,
    max_tokens: 2048,
  },
  utility: {
    provider: "openai_compat",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    has_api_key: false,
    temperature: 0.2,
    max_tokens: 256,
  },
  default_token_budget: 6000,
  auto_summarize: true,
  theme: "dark",
};

interface TierEditorProps {
  title: string;
  tier: "reasoning" | "utility";
  config: ModelTierConfig;
  maxTokensDraft: string;
  keyInput: string | null;
  testResult: TestConnectionResult | null;
  testing: boolean;
  onChangeConfig: (next: ModelTierConfig) => void;
  onChangeMaxTokensDraft: (next: string) => void;
  onCommitMaxTokens: () => void;
  onChangeKey: (next: string | null) => void;
  onTest: () => void;
}

function clampIntDraft(raw: string, min: number, fallback: number): number {
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return Math.max(min, fallback);
  }
  return Math.max(min, parsed);
}

function TierEditor({
  title,
  config,
  maxTokensDraft,
  keyInput,
  testResult,
  testing,
  onChangeConfig,
  onChangeMaxTokensDraft,
  onCommitMaxTokens,
  onChangeKey,
  onTest,
}: TierEditorProps) {
  const isClearing = keyInput === "";
  const showSavedBadge = config.has_api_key && !isClearing;
  const [tempText, setTempText] = useState<string>(() => String(config.temperature));

  useEffect(() => {
    setTempText(String(config.temperature));
  }, [config.temperature]);

  return (
    <section class="settings-section">
      <div class="settings-section__header">
        <h3 class="settings-section__title">{title}</h3>
        <button
          type="button"
          class="settings-btn settings-btn--secondary"
          disabled={testing}
          onClick={onTest}
        >
          {testing ? "Testing..." : "Test Connection"}
        </button>
      </div>

      <div class="settings-grid">
        <label class="settings-field">
          <span class="settings-field__label">Provider</span>
          <select
            class="settings-input"
            value={config.provider}
            onChange={(e) =>
              onChangeConfig({
                ...config,
                provider: e.currentTarget.value as ProviderKind,
              })
            }
          >
            <option value="openai_compat">OpenAI-Compatible</option>
            <option value="anthropic">Anthropic</option>
            <option value="ollama">Ollama (Local)</option>
          </select>
        </label>

        <label class="settings-field">
          <span class="settings-field__label">Model</span>
          <input
            type="text"
            class="settings-input"
            value={config.model}
            onInput={(e) => onChangeConfig({ ...config, model: e.currentTarget.value })}
          />
        </label>

        <label class="settings-field settings-field--wide">
          <span class="settings-field__label">Base URL</span>
          <input
            type="text"
            class="settings-input"
            value={config.base_url}
            onInput={(e) => onChangeConfig({ ...config, base_url: e.currentTarget.value })}
          />
        </label>

        <label class="settings-field settings-field--wide">
          <div class="settings-field__label-row">
            <span class="settings-field__label">API Key (OS Keychain)</span>
            {showSavedBadge && <span class="badge badge--pin">Key saved</span>}
            {isClearing && <span class="badge">Will clear on save</span>}
          </div>
          <div class="settings-key-row">
            <input
              type="password"
              class="settings-input"
              value={keyInput ?? ""}
              placeholder={
                showSavedBadge ? "Key saved — enter new key to replace" : "sk-... (optional for Ollama)"
              }
              onInput={(e) => {
                const v = e.currentTarget.value;
                onChangeKey(v.length === 0 ? null : v);
              }}
            />
            {(config.has_api_key || keyInput !== null) && (
              <button
                type="button"
                class="settings-btn settings-btn--secondary"
                onClick={() => onChangeKey("")}
              >
                Clear Key
              </button>
            )}
          </div>
        </label>

        <label class="settings-field">
          <span class="settings-field__label">Temperature</span>
          <input
            type="number"
            step="0.05"
            min="0"
            max="2"
            class="settings-input"
            value={tempText}
            onInput={(e) => {
              const raw = e.currentTarget.value;
              setTempText(raw);
              const parsed = Number.parseFloat(raw);
              if (Number.isFinite(parsed)) {
                const clamped = Math.min(2, Math.max(0, parsed));
                onChangeConfig({
                  ...config,
                  temperature: clamped,
                });
              }
            }}
            onBlur={() => {
              const parsed = Number.parseFloat(tempText);
              const clamped = Number.isFinite(parsed)
                ? Math.min(2, Math.max(0, parsed))
                : config.temperature;
              setTempText(String(clamped));
              if (clamped !== config.temperature) {
                onChangeConfig({
                  ...config,
                  temperature: clamped,
                });
              }
            }}
          />
        </label>

        <label class="settings-field">
          <span class="settings-field__label">Max Tokens</span>
          <input
            type="number"
            step="64"
            min="64"
            class="settings-input"
            value={maxTokensDraft}
            onInput={(e) => onChangeMaxTokensDraft(e.currentTarget.value)}
            onBlur={onCommitMaxTokens}
          />
        </label>
      </div>

      {testResult && (
        <div
          class={`settings-test-result ${
            testResult.ok ? "settings-test-result--ok" : "settings-test-result--err"
          }`}
        >
          <span>{testResult.ok ? "OK" : "Failed"}</span>
          <span>({testResult.latency_ms} ms)</span>
          <span>— {testResult.message}</span>
        </div>
      )}
    </section>
  );
}

const LENS_TAG_PATTERN = /^[a-z0-9_-]{2,24}$/;

interface LensFormDraft {
  editingId: string | null;
  name: string;
  tag: string;
  description: string;
  prompt_template: string;
  default_node_type: NodeType;
  default_edge_type: EdgeType;
  default_severity: Severity;
}

function normalizeLensTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, "");
}

function makeLensId(tag: string): string {
  return `lens_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function createEmptyLensForm(): LensFormDraft {
  return {
    editingId: null,
    name: "",
    tag: "",
    description: "",
    prompt_template: "",
    default_node_type: "branch",
    default_edge_type: "derives",
    default_severity: "medium",
  };
}

export function SettingsModal() {
  const isOpen = modalState.value === "command" && settingsModalOpen.value;

  const [reasoning, setReasoning] = useState<ModelTierConfig>(DEFAULT_SETTINGS.reasoning);
  const [utility, setUtility] = useState<ModelTierConfig>(DEFAULT_SETTINGS.utility);
  const [reasoningKey, setReasoningKey] = useState<string | null>(null);
  const [utilityKey, setUtilityKey] = useState<string | null>(null);
  const [defaultBudget, setDefaultBudget] = useState<number>(6000);
  const [tokenBudgetDraft, setTokenBudgetDraft] = useState<string>("6000");
  const [reasoningMaxTokensDraft, setReasoningMaxTokensDraft] = useState<string>(
    String(DEFAULT_SETTINGS.reasoning.max_tokens),
  );
  const [utilityMaxTokensDraft, setUtilityMaxTokensDraft] = useState<string>(
    String(DEFAULT_SETTINGS.utility.max_tokens),
  );
  const [autoSummarize, setAutoSummarize] = useState<boolean>(true);
  const [selectedTheme, setSelectedTheme] = useState<"dark" | "light">("dark");
  const [systemPromptDraft, setSystemPromptDraft] = useState<string>("");
  const [customLenses, setCustomLensesDraft] = useState<CustomLensDef[]>(() => [
    ...customLensesSignal.value,
  ]);
  const [lensForm, setLensForm] = useState<LensFormDraft | null>(null);
  const [lensFormError, setLensFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingTier, setTestingTier] = useState<"reasoning" | "utility" | null>(null);
  const [testResults, setTestResults] = useState<{
    reasoning: TestConnectionResult | null;
    utility: TestConnectionResult | null;
  }>({ reasoning: null, utility: null });

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setReasoningKey(null);
    setUtilityKey(null);
    setTestResults({ reasoning: null, utility: null });
    setSystemPromptDraft(flowSystemPrompt.value);
    setLensForm(null);
    setLensFormError(null);

    if (!isTauriRuntime()) {
      setDefaultBudget(tokenBudget.value);
      setTokenBudgetDraft(String(tokenBudget.value));
      setReasoningMaxTokensDraft(String(reasoning.max_tokens));
      setUtilityMaxTokensDraft(String(utility.max_tokens));
      setSelectedTheme(theme.value);
      setCustomLensesDraft([...customLensesSignal.value]);
      return;
    }

    void getSettings()
      .then((dto) => {
        const loadedLenses = dto.custom_lenses ?? [];
        setReasoning(dto.reasoning);
        setUtility(dto.utility);
        setDefaultBudget(dto.default_token_budget);
        setTokenBudgetDraft(String(dto.default_token_budget));
        setReasoningMaxTokensDraft(String(dto.reasoning.max_tokens));
        setUtilityMaxTokensDraft(String(dto.utility.max_tokens));
        setAutoSummarize(dto.auto_summarize);
        setSelectedTheme(dto.theme);
        setCustomLensesDraft(loadedLenses);
        setCustomLenses(loadedLenses);
      })
      .catch((err) => {
        pushToast(parseIpcError(err).message, "error");
      });
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const commitTokenBudgetDraft = (): number => {
    const next = clampIntDraft(tokenBudgetDraft, 512, defaultBudget);
    setDefaultBudget(next);
    setTokenBudgetDraft(String(next));
    return next;
  };

  const commitReasoningMaxTokensDraft = (): number => {
    const next = clampIntDraft(reasoningMaxTokensDraft, 64, reasoning.max_tokens);
    setReasoning((prev) => ({ ...prev, max_tokens: next }));
    setReasoningMaxTokensDraft(String(next));
    return next;
  };

  const commitUtilityMaxTokensDraft = (): number => {
    const next = clampIntDraft(utilityMaxTokensDraft, 64, utility.max_tokens);
    setUtility((prev) => ({ ...prev, max_tokens: next }));
    setUtilityMaxTokensDraft(String(next));
    return next;
  };

  const buildInput = (
    committedBudget: number,
    committedReasoningMax: number,
    committedUtilityMax: number,
  ): SaveSettingsInput => ({
    reasoning: { ...reasoning, max_tokens: committedReasoningMax },
    reasoning_api_key: reasoningKey,
    utility: { ...utility, max_tokens: committedUtilityMax },
    utility_api_key: utilityKey,
    default_token_budget: committedBudget,
    auto_summarize: autoSummarize,
    theme: selectedTheme,
    custom_lenses: customLenses,
  });

  const handleInstallPreset = (preset: (typeof BUILTIN_LENS_PRESETS)[number]): void => {
    const normalized = normalizeLensTag(preset.tag);
    if (customLenses.some((l) => normalizeLensTag(l.tag) === normalized)) {
      return;
    }
    const created: CustomLensDef = {
      ...preset,
      id: makeLensId(normalized),
      tag: normalized,
    };
    setCustomLensesDraft((prev) => [...prev, created]);
  };

  const handleOpenAddLens = (): void => {
    setLensFormError(null);
    setLensForm(createEmptyLensForm());
  };

  const handleOpenEditLens = (lens: CustomLensDef): void => {
    setLensFormError(null);
    setLensForm({
      editingId: lens.id,
      name: lens.name,
      tag: lens.tag,
      description: lens.description,
      prompt_template: lens.prompt_template,
      default_node_type: lens.default_node_type,
      default_edge_type: lens.default_edge_type,
      default_severity: lens.default_severity ?? "medium",
    });
  };

  const handleDeleteLens = (id: string): void => {
    setCustomLensesDraft((prev) => prev.filter((l) => l.id !== id));
    if (lensForm?.editingId === id) {
      setLensForm(null);
      setLensFormError(null);
    }
  };

  const handleCommitLensForm = (): void => {
    if (!lensForm) {
      return;
    }
    const name = lensForm.name.trim();
    const tag = normalizeLensTag(lensForm.tag);
    const description = lensForm.description.trim();
    const promptTemplate = lensForm.prompt_template.trim();

    if (name.length === 0) {
      setLensFormError("Lens name is required.");
      return;
    }
    if (!LENS_TAG_PATTERN.test(tag)) {
      setLensFormError("Tag must be 2–24 characters using lowercase a-z, 0-9, _ or -.");
      return;
    }
    const collidesBuiltin = ACTION_TAGS.some(
      (def) =>
        def.tag.slice(1).toLowerCase() === tag ||
        def.aliases.some((alias) => alias.toLowerCase() === tag),
    );
    if (collidesBuiltin) {
      setLensFormError(`Tag @${tag} conflicts with a built-in action tag.`);
      return;
    }
    const collidesCustom = customLenses.some(
      (l) => l.id !== lensForm.editingId && normalizeLensTag(l.tag) === tag,
    );
    if (collidesCustom) {
      setLensFormError(`A custom lens with @${tag} is already installed.`);
      return;
    }
    if (promptTemplate.length === 0) {
      setLensFormError("Prompt template is required.");
      return;
    }

    const nextLens: CustomLensDef = {
      id: lensForm.editingId ?? makeLensId(tag),
      name,
      tag,
      description,
      prompt_template: promptTemplate,
      default_node_type: lensForm.default_node_type,
      default_edge_type: lensForm.default_edge_type,
      default_severity:
        lensForm.default_node_type === "loophole" ? lensForm.default_severity : null,
    };

    setCustomLensesDraft((prev) => {
      if (lensForm.editingId) {
        return prev.map((l) => (l.id === lensForm.editingId ? nextLens : l));
      }
      return [...prev, nextLens];
    });
    setLensForm(null);
    setLensFormError(null);
  };

  const handleSave = async (closeAfter: boolean): Promise<boolean> => {
    if (lensForm !== null) {
      setLensFormError("Save or cancel the custom lens draft before saving settings.");
      return false;
    }
    for (const lens of customLenses) {
      const normalized = normalizeLensTag(lens.tag);
      if (!LENS_TAG_PATTERN.test(normalized)) {
        pushToast(`Invalid custom lens tag "@${lens.tag}" (must match [a-z0-9_-]{2,24})`, "error");
        return false;
      }
    }

    const committedBudget = commitTokenBudgetDraft();
    const committedReasoningMax = commitReasoningMaxTokensDraft();
    const committedUtilityMax = commitUtilityMaxTokensDraft();

    if (!isTauriRuntime()) {
      setTheme(selectedTheme);
      tokenBudget.value = committedBudget;
      flowSystemPrompt.value = systemPromptDraft;
      setCustomLenses(customLenses);
      pushToast("Settings updated (local preview)", "info");
      if (closeAfter) {
        closeSettingsModal();
      }
      return true;
    }

    setSaving(true);
    try {
      const saved = await saveSettings(
        buildInput(committedBudget, committedReasoningMax, committedUtilityMax),
      );
      if (systemPromptDraft !== flowSystemPrompt.value) {
        await saveFlowSystemPrompt(systemPromptDraft);
        flowSystemPrompt.value = systemPromptDraft;
      }
      const savedLenses = saved.custom_lenses ?? customLenses;
      setReasoning(saved.reasoning);
      setUtility(saved.utility);
      setReasoningMaxTokensDraft(String(saved.reasoning.max_tokens));
      setUtilityMaxTokensDraft(String(saved.utility.max_tokens));
      setDefaultBudget(saved.default_token_budget);
      setTokenBudgetDraft(String(saved.default_token_budget));
      setReasoningKey(null);
      setUtilityKey(null);
      setCustomLensesDraft(savedLenses);
      setCustomLenses(savedLenses);
      setTheme(saved.theme);
      tokenBudget.value = saved.default_token_budget;
      if (closeAfter) {
        pushToast("Settings saved", "info");
        closeSettingsModal();
      }
      return true;
    } catch (err) {
      pushToast(parseIpcError(err).message, "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (tier: "reasoning" | "utility"): Promise<void> => {
    if (!isTauriRuntime()) {
      setTestResults((prev) => ({
        ...prev,
        [tier]: {
          ok: false,
          latency_ms: 0,
          message: "Connection test requires the Axiom desktop runtime",
        },
      }));
      return;
    }

    const savedOk = await handleSave(false);
    if (!savedOk) {
      return;
    }

    setTestingTier(tier);
    try {
      const res = await testProviderConnection(tier);
      setTestResults((prev) => ({ ...prev, [tier]: res }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [tier]: { ok: false, latency_ms: 0, message: parseIpcError(err).message },
      }));
    } finally {
      setTestingTier(null);
    }
  };

  return (
    <div
      class="settings-modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          closeSettingsModal();
        }
      }}
    >
      <div
        class="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Axiom Settings"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeSettingsModal();
          }
        }}
      >
        <header class="settings-modal__header">
          <h2 class="settings-modal__title">AI &amp; Workspace Settings</h2>
          <button
            type="button"
            class="settings-btn settings-btn--secondary"
            onClick={closeSettingsModal}
          >
            Close (Esc)
          </button>
        </header>

        <div class="settings-modal__body">
          {!isTauriRuntime() && (
            <p class="settings-preview-banner" role="note">
              Browser preview mode: API keys and keychain tests require the Axiom desktop app.
            </p>
          )}
          <TierEditor
            title="Reasoning Tier (AI Lenses)"
            tier="reasoning"
            config={reasoning}
            maxTokensDraft={reasoningMaxTokensDraft}
            keyInput={reasoningKey}
            testResult={testResults.reasoning}
            testing={testingTier === "reasoning"}
            onChangeConfig={setReasoning}
            onChangeMaxTokensDraft={setReasoningMaxTokensDraft}
            onCommitMaxTokens={() => {
              commitReasoningMaxTokensDraft();
            }}
            onChangeKey={setReasoningKey}
            onTest={() => void handleTest("reasoning")}
          />

          <TierEditor
            title="Utility Tier (Background Summaries)"
            tier="utility"
            config={utility}
            maxTokensDraft={utilityMaxTokensDraft}
            keyInput={utilityKey}
            testResult={testResults.utility}
            testing={testingTier === "utility"}
            onChangeConfig={setUtility}
            onChangeMaxTokensDraft={setUtilityMaxTokensDraft}
            onCommitMaxTokens={() => {
              commitUtilityMaxTokensDraft();
            }}
            onChangeKey={setUtilityKey}
            onTest={() => void handleTest("utility")}
          />

          <section class="settings-section">
            <h3 class="settings-section__title">Workspace &amp; Appearance</h3>
            <div class="settings-grid">
              <label class="settings-field">
                <span class="settings-field__label">Default Token Budget</span>
                <input
                  type="number"
                  min="512"
                  step="256"
                  class="settings-input"
                  value={tokenBudgetDraft}
                  onInput={(e) => setTokenBudgetDraft(e.currentTarget.value)}
                  onBlur={() => {
                    commitTokenBudgetDraft();
                  }}
                />
              </label>

              <label class="settings-field">
                <span class="settings-field__label">Theme</span>
                <select
                  class="settings-input"
                  value={selectedTheme}
                  onChange={(e) =>
                    setSelectedTheme(e.currentTarget.value as "dark" | "light")
                  }
                >
                  <option value="dark">Dark (Monochrome)</option>
                  <option value="light">Light (Monochrome)</option>
                </select>
              </label>

              <label class="settings-checkbox settings-field--wide">
                <input
                  type="checkbox"
                  checked={autoSummarize}
                  onChange={(e) => setAutoSummarize(e.currentTarget.checked)}
                />
                <span>Auto-summarize updated nodes in background (1500 ms debounce)</span>
              </label>

              <label class="settings-field settings-field--wide">
                <span class="settings-field__label">Flow System Instructions</span>
                <textarea
                  class="settings-textarea"
                  rows={4}
                  placeholder="Optional system instructions applied to all AI lenses in this flow..."
                  value={systemPromptDraft}
                  onInput={(e) => setSystemPromptDraft(e.currentTarget.value)}
                />
              </label>
            </div>
          </section>

          <section class="settings-section" aria-label="Custom Lenses">
            <div class="settings-section__header">
              <h3 class="settings-section__title">Custom Lenses (@tags)</h3>
              <button
                type="button"
                class="settings-btn settings-btn--secondary"
                onClick={handleOpenAddLens}
              >
                + Add Lens
              </button>
            </div>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "6px",
                marginBottom: "10px",
              }}
            >
              <span class="settings-field__label">Starter Presets:</span>
              {BUILTIN_LENS_PRESETS.map((preset) => {
                const installed = customLenses.some(
                  (l) => normalizeLensTag(l.tag) === normalizeLensTag(preset.tag),
                );
                return (
                  <button
                    key={preset.tag}
                    type="button"
                    class="settings-btn settings-btn--secondary"
                    title={preset.name}
                    disabled={installed}
                    onClick={() => handleInstallPreset(preset)}
                  >
                    + @{preset.tag}
                  </button>
                );
              })}
            </div>

            {customLenses.length === 0 ? (
              <p class="related-popover__empty">
                No custom lenses installed. Install a starter preset or add your own @tag lens.
              </p>
            ) : (
              <ul class="related-popover__list" style={{ marginBottom: lensForm ? "10px" : "0" }}>
                {customLenses.map((lens) => (
                  <li key={lens.id} class="related-popover__item">
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "8px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <span class="badge badge--pin">@{normalizeLensTag(lens.tag)}</span>
                        <strong>{lens.name}</strong>
                        <span class="settings-field__label">
                          {lens.default_node_type} / {lens.default_edge_type}
                          {lens.default_node_type === "loophole" && lens.default_severity
                            ? ` (${lens.default_severity})`
                            : ""}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button
                          type="button"
                          class="settings-btn settings-btn--secondary"
                          onClick={() => handleOpenEditLens(lens)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          class="settings-btn settings-btn--secondary"
                          onClick={() => handleDeleteLens(lens.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {lens.description && (
                      <span class="settings-field__label">{lens.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {lensForm && (
              <div class="settings-section" style={{ marginTop: "10px" }}>
                <div class="settings-section__header">
                  <h4 class="settings-section__title">
                    {lensForm.editingId ? "Edit Custom Lens" : "Add Custom Lens"}
                  </h4>
                </div>
                <div class="settings-grid">
                  <label class="settings-field">
                    <span class="settings-field__label">Name</span>
                    <input
                      type="text"
                      class="settings-input"
                      placeholder="STRIDE Threat Model"
                      value={lensForm.name}
                      onInput={(e) => {
                        const val = e.currentTarget.value;
                        setLensForm((prev) => (prev ? { ...prev, name: val } : prev));
                      }}
                    />
                  </label>

                  <label class="settings-field">
                    <span class="settings-field__label">@tag</span>
                    <input
                      type="text"
                      class="settings-input"
                      placeholder="threat"
                      value={lensForm.tag}
                      onInput={(e) => {
                        const val = e.currentTarget.value;
                        setLensForm((prev) => (prev ? { ...prev, tag: val } : prev));
                      }}
                    />
                  </label>

                  <label class="settings-field settings-field--wide">
                    <span class="settings-field__label">Description</span>
                    <input
                      type="text"
                      class="settings-input"
                      placeholder="Short description shown in @tag menu"
                      value={lensForm.description}
                      onInput={(e) => {
                        const val = e.currentTarget.value;
                        setLensForm((prev) => (prev ? { ...prev, description: val } : prev));
                      }}
                    />
                  </label>

                  <label class="settings-field settings-field--wide">
                    <span class="settings-field__label">Prompt Template</span>
                    <textarea
                      class="settings-input settings-lens-form__textarea"
                      rows={3}
                      placeholder="Instructions for how this lens analyzes the focused context..."
                      value={lensForm.prompt_template}
                      onInput={(e) => {
                        const val = e.currentTarget.value;
                        setLensForm((prev) =>
                          prev ? { ...prev, prompt_template: val } : prev,
                        );
                      }}
                    />
                  </label>

                  <label class="settings-field">
                    <span class="settings-field__label">Default Card Type</span>
                    <select
                      class="settings-input"
                      value={lensForm.default_node_type}
                      onChange={(e) => {
                        const val = e.currentTarget.value as NodeType;
                        setLensForm((prev) =>
                          prev ? { ...prev, default_node_type: val } : prev,
                        );
                      }}
                    >
                      <option value="core">core</option>
                      <option value="branch">branch</option>
                      <option value="loophole">loophole</option>
                      <option value="probe">probe</option>
                      <option value="synthesis">synthesis</option>
                    </select>
                  </label>

                  <label class="settings-field">
                    <span class="settings-field__label">Default Edge</span>
                    <select
                      class="settings-input"
                      value={lensForm.default_edge_type}
                      onChange={(e) => {
                        const val = e.currentTarget.value as EdgeType;
                        setLensForm((prev) =>
                          prev ? { ...prev, default_edge_type: val } : prev,
                        );
                      }}
                    >
                      <option value="derives">derives</option>
                      <option value="branches">branches</option>
                      <option value="challenges">challenges</option>
                      <option value="resolves">resolves</option>
                      <option value="synthesizes">synthesizes</option>
                      <option value="references">references</option>
                    </select>
                  </label>

                  {lensForm.default_node_type === "loophole" && (
                    <label class="settings-field">
                      <span class="settings-field__label">Default Severity</span>
                      <select
                        class="settings-input"
                        value={lensForm.default_severity}
                        onChange={(e) => {
                          const val = e.currentTarget.value as Severity;
                          setLensForm((prev) =>
                            prev ? { ...prev, default_severity: val } : prev,
                          );
                        }}
                      >
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                        <option value="critical">critical</option>
                      </select>
                    </label>
                  )}
                </div>

                {lensFormError && (
                  <p class="settings-test-result settings-test-result--err" role="alert">
                    {lensFormError}
                  </p>
                )}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "8px",
                    marginTop: "10px",
                  }}
                >
                  <button
                    type="button"
                    class="settings-btn settings-btn--secondary"
                    onClick={() => {
                      setLensForm(null);
                      setLensFormError(null);
                    }}
                  >
                    Cancel Lens
                  </button>
                  <button
                    type="button"
                    class="settings-btn settings-btn--primary"
                    onClick={handleCommitLensForm}
                  >
                    {lensForm.editingId ? "Update Lens" : "Save Lens"}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>

        <footer class="settings-modal__footer">
          <button
            type="button"
            class="settings-btn settings-btn--secondary"
            onClick={closeSettingsModal}
          >
            Cancel
          </button>
          <button
            type="button"
            class="settings-btn settings-btn--primary"
            disabled={saving}
            onClick={() => void handleSave(true)}
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </footer>
      </div>
    </div>
  );
}
