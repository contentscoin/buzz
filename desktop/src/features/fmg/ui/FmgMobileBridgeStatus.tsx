import * as React from "react";
import {
  getMobileBridgeStatus,
  subscribeMobileBridgeStatus,
  retryMobileBridge,
} from "@/shared/mobile/mobileBridgeStatus";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardHeader } from "@/shared/ui/card";

const labels = {
  starting: "모바일 요청 수신기 연결 중",
  ready: "모바일 요청 수신 대기",
  failed: "모바일 요청 수신기 연결 실패",
  stopped: "모바일 요청 수신기 중지됨",
};

/** Separates receiver readiness from a real phone request and reply. */
export function FmgMobileBridgeStatus({
  owner,
  relayUrl,
}: {
  owner?: string;
  relayUrl?: string;
}) {
  const status = React.useSyncExternalStore(
    subscribeMobileBridgeStatus,
    getMobileBridgeStatus,
    getMobileBridgeStatus,
  );
  const relay = relayUrl
    ?.replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:")
    .replace(/\/$/, "");
  if (relay !== "https://fmg.communities.buzz.xyz") return null;
  const current =
    status?.owner === owner && status?.relay === relay ? status : null;
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">PC · 모바일 제어 연결</h2>
      </CardHeader>
      <CardContent className="space-y-3">
        <p role="status">
          {current ? labels[current.phase] : "모바일 요청 수신 상태 미확인"}
        </p>
        <p className="text-sm text-muted-foreground">
          수신 대기는 휴대폰 연결 완료를 뜻하지 않습니다. 휴대폰에서 PC 연결 /
          새로 고침을 눌러 응답을 확인하세요.
        </p>
        {current ? (
          <p className="text-sm">
            요청 수신 {current.received}건 · 응답 전송 {current.responded}건
            {current.lastAction ? ` · 최근 요청 ${current.lastAction}` : ""}
          </p>
        ) : null}
        {current?.lastError ? (
          <p className="text-sm text-destructive">
            연결 오류: {current.lastError}
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          disabled={!owner || current?.phase === "starting"}
          onClick={retryMobileBridge}
        >
          모바일 제어 다시 연결
        </Button>
      </CardContent>
    </Card>
  );
}
