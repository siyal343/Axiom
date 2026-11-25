import { useEffect, useState } from "preact/hooks";
import {
  getSettings,
  isTauriRuntime,
  parseIpcError,
  saveSettings,
  testProviderConnection,
} from "../ipc/client";
import type {
  AppSettingsDto,
  ModelTierConfig,
  ProviderKind,
  SaveSettingsInput,
  TestConnectionResult,
} from "../ipc/types";
import { closeSettingsModal, settingsModalOpen } from "../store/aiRunner";
import { theme, tokenBudget } from "../store/graphStore";
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

    if (!isTauriRuntime()) {
      setDefaultBudget(tokenBudget.value);
      setTokenBudgetDraft(String(tokenBudget.value));
      setReasoningMaxTokensDraft(String(reasoning.max_tokens));
      setUtilityMaxTokensDraft(String(utility.max_tokens));
      setSelectedTheme(theme.value);
      return;
    }

    void getSettings()
      .then((dto) => {
        setReasoning(dto.reasoning);
        setUtility(dto.utility);
        setDefaultBudget(dto.default_token_budget);
        setTokenBudgetDraft(String(dto.default_token_budget));
        setReasoningMaxTokensDraft(String(dto.reasoning.max_tokens));
        setUtilityMaxTokensDraft(String(dto.utility.max_tokens));
        setAutoSummarize(dto.auto_summarize);
        setSelectedTheme(dto.theme);
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
  });

  const handleSave = async (closeAfter: boolean): Promise<boolean> => {
    const committedBudget = commitTokenBudgetDraft();
    const committedReasoningMax = commitReasoningMaxTokensDraft();
    const committedUtilityMax = commitUtilityMaxTokensDraft();

    if (!isTauriRuntime()) {
      theme.value = selectedTheme;
      tokenBudget.value = committedBudget;
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
      setReasoning(saved.reasoning);
      setUtility(saved.utility);
      setReasoningMaxTokensDraft(String(saved.reasoning.max_tokens));
      setUtilityMaxTokensDraft(String(saved.utility.max_tokens));
      setDefaultBudget(saved.default_token_budget);
      setTokenBudgetDraft(String(saved.default_token_budget));
      setReasoningKey(null);
      setUtilityKey(null);
      theme.value = saved.theme;
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
            </div>
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
