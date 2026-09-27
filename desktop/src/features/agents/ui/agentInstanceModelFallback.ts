import {
  getBakedModelInheritLabel,
  type InheritedDefault,
} from "./bakedEnvHelpers";
import {
  getDefaultLlmModelLabel,
  getPersonaModelOptions,
} from "./agentConfigOptions";

export function deriveAgentInstanceModelFallback(
  runtimeId: string,
  providerId: string,
  inheritedModel: InheritedDefault,
) {
  const label =
    inheritedModel.source === "build"
      ? getBakedModelInheritLabel(inheritedModel.value)
      : getDefaultLlmModelLabel(inheritedModel.value);
  const options =
    runtimeId === "claude" || runtimeId === "codex"
      ? getPersonaModelOptions(runtimeId, providerId).map((option) =>
          option.id === "" ? { ...option, label } : option,
        )
      : [{ id: "", label }];

  return { label, options };
}
