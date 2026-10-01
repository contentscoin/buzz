import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getFmgBrowserConfig,
  setFmgBrowserConfig,
  type FmgBrowserConfig,
} from "@/shared/api/tauriFmg";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { SettingsOptionGroup } from "@/features/settings/ui/SettingsOptionGroup";

export function FmgBrowserSettingsCard() {
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: ["fmg", "browser-config"],
    queryFn: getFmgBrowserConfig,
  });
  return (
    <SettingsOptionGroup
      title="Aside 브라우저"
      description="이 컴퓨터에서 시작하는 ACP 에이전트에 브라우저 도구를 연결합니다."
    >
      <div className="space-y-3 px-4 py-4" data-testid="fmg-browser-settings">
        {configQuery.isPending ? (
          <p role="status">설정을 불러오는 중입니다.</p>
        ) : configQuery.isError ? (
          <div role="alert">
            <p>설정을 읽지 못했습니다: {String(configQuery.error)}</p>
            <Button
              onClick={() => void configQuery.refetch()}
              variant="outline"
            >
              다시 불러오기
            </Button>
          </div>
        ) : (
          <BrowserForm
            config={configQuery.data}
            onSaved={(config) => {
              queryClient.setQueryData(["fmg", "browser-config"], config);
              void queryClient.invalidateQueries({
                queryKey: ["fmg", "runtime-status"],
              });
            }}
          />
        )}
      </div>
    </SettingsOptionGroup>
  );
}

function BrowserForm({
  config,
  onSaved,
}: {
  config: FmgBrowserConfig;
  onSaved: (config: FmgBrowserConfig) => void;
}) {
  const id = React.useId();
  const [draft, setDraft] = React.useState(config);
  const [pending, setPending] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    setMessage("");
    const saved = {
      ...draft,
      command: draft.mode === "custom" ? draft.command.trim() : "",
    };
    try {
      await setFmgBrowserConfig(saved);
      setDraft(saved);
      setMessage("저장했습니다. 새로 시작하는 로컬 에이전트부터 적용됩니다.");
      onSaved(saved);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="space-y-3" onSubmit={(event) => void save(event)}>
      <label className="block text-sm font-medium" htmlFor={`${id}-mode`}>
        연결 방식
      </label>
      <select
        id={`${id}-mode`}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        disabled={pending}
        value={draft.mode}
        onChange={(event) => {
          setMessage("");
          setError("");
          setDraft({
            ...draft,
            mode: event.target.value as FmgBrowserConfig["mode"],
          });
        }}
      >
        <option value="environment">앱 실행 환경의 설정 사용</option>
        <option value="custom">설치된 Aside 실행 파일 지정</option>
        <option value="disabled">사용 안 함</option>
      </select>
      {draft.mode === "custom" ? (
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor={`${id}-command`}>
            Aside 실행 파일의 전체 경로
          </label>
          <Input
            id={`${id}-command`}
            value={draft.command}
            maxLength={4096}
            disabled={pending}
            required
            onChange={(event) => {
              setMessage("");
              setError("");
              setDraft({ ...draft, command: event.target.value });
            }}
            placeholder="C:\…\aside.exe"
          />
          <p className="text-xs text-muted-foreground">
            실행 파일 경로만 입력하세요. 인수와 따옴표는 붙이지 않습니다.
          </p>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        현재 실행 중인 에이전트는 Agents에서 필요할 때 다시 시작하세요. 서버의
        OpenClaw에는 별도 설정이 필요합니다.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      <Button
        type="submit"
        size="sm"
        disabled={pending || (draft.mode === "custom" && !draft.command.trim())}
      >
        {pending ? "저장 중…" : "브라우저 설정 저장"}
      </Button>
    </form>
  );
}
