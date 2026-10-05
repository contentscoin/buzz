import { PersonaDropdownField } from "./PersonaDropdownField";
import type { ManagedAgent, RuntimeConfigSurface } from "@/shared/api/types";
import { EffortPickerField } from "./EffortPickerField";
import {
  EFFORT_DEFAULT_DROPDOWN_VALUE,
  effortSelectionToPersistedValue,
} from "./effortPicker";
import type { PersonaModelOption } from "./agentConfigOptions";

/** ACP legacy model IDs carry effort as model[effort]; no env override is written. */
export function splitModelEffort(id: string) {
  const match = /^(.*)\[([a-z]+)\]$/.exec(id);
  return { model: match?.[1] ?? id, effort: match?.[2] ?? "" };
}

/** Read effort choices only from the selected model's discovered catalog. */
export function modelEffortOptions(
  model: string,
  options: readonly PersonaModelOption[] | null,
) {
  const selected = splitModelEffort(model.trim());
  return (options ?? []).flatMap((option) => {
    const parsed = splitModelEffort(option.id);
    return parsed.model === selected.model && parsed.effort
      ? [{ value: option.id, label: parsed.effort }]
      : [];
  });
}

function modelLabel(
  model: string,
  options: readonly PersonaModelOption[] | null,
) {
  const base = splitModelEffort(model.trim()).model;
  return options?.find((option) => option.id === base)?.label ?? base;
}

/** Save local instance effort canonically; never borrow another model's session choices. */
export function AgentEffortFields({
  agent,
  config,
  model,
  options,
  disabled,
  value,
  onChange,
  definitionName,
}: {
  agent: ManagedAgent;
  config: RuntimeConfigSurface | undefined;
  model: string;
  options: readonly PersonaModelOption[] | null;
  disabled: boolean;
  value: string | null;
  onChange: (effort: string | null) => void;
  definitionName?: string;
}) {
  if (agent.backend.type !== "local") return null;
  const catalogOptions = modelEffortOptions(model, options);
  if (catalogOptions.length > 0) {
    const knownValue = catalogOptions.some((option) => option.label === value);
    return (
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="edit-agent-effort">
          추론 강도 (effort)
        </label>
        <PersonaDropdownField
          id="edit-agent-effort"
          disabled={disabled}
          value={knownValue ? (value as string) : EFFORT_DEFAULT_DROPDOWN_VALUE}
          options={[
            { value: EFFORT_DEFAULT_DROPDOWN_VALUE, label: "모델 설정 사용" },
            ...catalogOptions.map((option) => ({
              value: option.label,
              label: option.label,
            })),
          ]}
          onValueChange={(next) =>
            onChange(effortSelectionToPersistedValue(next))
          }
          placeholder="모델 설정 사용"
        />
        <p className="text-xs text-muted-foreground">
          적용 모델: {modelLabel(model, options)}. 저장 후 다음 세션 시작에
          적용됩니다.
        </p>
        {definitionName ? (
          <p className="text-xs text-muted-foreground">
            모델 변경은 {definitionName} 에이전트 정의 편집에서 저장하세요.
          </p>
        ) : null}
        {value && !knownValue ? (
          <p className="text-xs text-muted-foreground">
            현재 설정 {value}는 선택 모델의 목록에서 확인되지 않았습니다. 변경은
            저장할 때 적용됩니다.
          </p>
        ) : null}
      </div>
    );
  }
  const currentModel = config?.normalized.model?.value ?? agent.model ?? "";
  const sameModel =
    splitModelEffort(currentModel).model === splitModelEffort(model).model;
  if (config?.effortConfigId && sameModel)
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
  return config?.effortConfigId && !sameModel ? (
    <p className="text-xs text-muted-foreground">
      선택 모델의 effort 목록을 확인하지 못했습니다. 편집 화면을 다시 열어
      조회하세요.
    </p>
  ) : null;
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
  const values = modelEffortOptions(model, options);
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
        선택 모델: {modelLabel(model, options)}. 저장한 모델과 함께 다음 세션
        시작에 적용됩니다.
      </p>
    </div>
  );
}
