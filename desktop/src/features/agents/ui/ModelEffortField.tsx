import { PersonaDropdownField } from "./PersonaDropdownField";
import type { ManagedAgent, RuntimeConfigSurface } from "@/shared/api/types";
import { EffortPickerField } from "./EffortPickerField";
import type { PersonaModelOption } from "./agentConfigOptions";

/** ACP legacy model IDs carry effort as model[effort]; no env override is written. */
export function splitModelEffort(id: string) {
  const match = /^(.*)\[([a-z]+)\]$/.exec(id);
  return { model: match?.[1] ?? id, effort: match?.[2] ?? "" };
}

/** Prefer reported session-native effort; otherwise use discovered model IDs. */
export function AgentEffortFields({
  agent,
  config,
  model,
  options,
  disabled,
  value,
  onChange,
  onModelChange,
}: {
  agent: ManagedAgent;
  config: RuntimeConfigSurface | undefined;
  model: string;
  options: readonly PersonaModelOption[] | null;
  disabled: boolean;
  value: string | null;
  onChange: (effort: string | null) => void;
  onModelChange: (model: string) => void;
}) {
  if (config?.effortConfigId)
    return (
      <EffortPickerField
        agent={agent}
        config={config}
        model={model}
        disabled={disabled}
        value={value}
        onChange={onChange}
      />
    );
  if (agent.backend.type !== "local") return null;
  return (
    <ModelEffortField
      id="edit-agent-model-effort"
      model={model}
      options={options}
      disabled={disabled}
      onChange={(next) => {
        onModelChange(next);
        onChange(null);
      }}
    />
  );
}

/** Options come exclusively from the current adapter's discovered catalog. */
export function ModelEffortField({
  id,
  model,
  options,
  disabled,
  onChange,
}: {
  id: string;
  model: string;
  options: readonly PersonaModelOption[] | null;
  disabled: boolean;
  onChange: (modelId: string) => void;
}) {
  const selected = splitModelEffort(model);
  const values = (options ?? []).flatMap((option) => {
    const parsed = splitModelEffort(option.id);
    return parsed.model === selected.model && parsed.effort
      ? [{ value: option.id, label: parsed.effort }]
      : [];
  });
  if (values.length === 0) return null;
  const known = values.some((option) => option.value === model);
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium" htmlFor={id}>
        추론 강도 (effort)
      </label>
      <PersonaDropdownField
        id={id}
        disabled={disabled}
        value={known ? model : selected.model}
        options={[{ value: selected.model, label: "모델 기본값" }, ...values]}
        placeholder="모델 기본값"
        onValueChange={onChange}
      />
      <p className="text-xs text-muted-foreground">
        저장한 모델과 함께 다음 세션 시작에 적용됩니다.
      </p>
    </div>
  );
}
