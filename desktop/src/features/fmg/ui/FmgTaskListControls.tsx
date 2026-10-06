import type { TaskSummary } from "../taskRpc";
import { taskStatusLabel } from "../taskRpc";
import type { TaskStatusFilter } from "../taskPresentation";
import { Button } from "@/shared/ui/button";

/** Search and counts describe this fetched window, never the whole ledger. */
export function FmgTaskListControls({
  tasks,
  search,
  status,
  visibleCount,
  onSearch,
  onStatus,
}: {
  tasks: readonly TaskSummary[];
  search: string;
  status: TaskStatusFilter;
  visibleCount: number;
  onSearch: (value: string) => void;
  onStatus: (value: TaskStatusFilter) => void;
}) {
  return (
    <section
      aria-label="조회한 작업 검색과 필터"
      className="space-y-3 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 space-y-1 text-sm">
          <span className="block">작업 검색</span>
          <input
            type="search"
            aria-label="작업 ID·해시·역할·모델·effort 검색"
            placeholder="작업 ID, 해시, 역할, 모델, effort"
            value={search}
            maxLength={200}
            onChange={(event) => onSearch(event.target.value)}
            className="w-full rounded-md border bg-background p-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block">작업 상태</span>
          <select
            aria-label="작업 상태 필터"
            value={status}
            onChange={(event) =>
              onStatus(event.target.value as TaskStatusFilter)
            }
            className="max-w-full rounded-md border bg-background p-2"
          >
            <option value="all">모든 상태 ({tasks.length})</option>
            {Object.entries(taskStatusLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label} ({tasks.filter((task) => task.status === value).length})
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="ghost"
          disabled={!search && status === "all"}
          onClick={() => {
            onSearch("");
            onStatus("all");
          }}
        >
          필터 초기화
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        조회한 최근 {tasks.length}건 중 {visibleCount}건 표시 · 검색과 개수는
        최근 25건 이내의 조회 목록에만 적용됩니다.
      </p>
    </section>
  );
}
