import { ChevronRight, FileCode2, FileText, Image } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { WebGitReviewFile } from "../../../../protocol/types.ts";

interface Directory {
  path: string;
  name: string;
  directories: Map<string, Directory>;
  files: WebGitReviewFile[];
}

function directory(path: string, name: string): Directory {
  return { path, name, directories: new Map(), files: [] };
}

export function ReviewFileTree({
  files,
  selectedPath,
  collapsed,
  searching,
  onToggle,
  onSelect,
  viewed,
  onViewedChange,
  viewedLimitReached = false,
}: {
  files: WebGitReviewFile[];
  selectedPath: string | null;
  collapsed: ReadonlySet<string>;
  searching: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  viewed?: ReadonlySet<string>;
  onViewedChange?: (path: string, checked: boolean) => void;
  viewedLimitReached?: boolean;
}) {
  const { t } = useTranslation();
  const root = useMemo(() => {
    const root = directory("", "");
    for (const file of files) {
      let parent = root;
      for (const name of file.path.split("/").slice(0, -1)) {
        const path = parent.path ? `${parent.path}/${name}` : name;
        let child = parent.directories.get(name);
        if (!child) {
          child = directory(path, name);
          parent.directories.set(name, child);
        }
        parent = child;
      }
      parent.files.push(file);
    }
    return root;
  }, [files]);
  const children = (parent: Directory, depth: number) => (
    <ul>
      {[...parent.directories.values()].map((entry) => {
        let node = entry;
        let label = node.name;
        while (node.files.length === 0 && node.directories.size === 1) {
          const child = node.directories.values().next().value;
          if (!child) break;
          node = child;
          label += `/${node.name}`;
        }
        const path = node.path;
        const open = searching || !collapsed.has(path);
        return (
          <li key={entry.path}>
            <button
              type="button"
              className="review-tree-directory"
              style={{ paddingLeft: 8 + depth * 16 }}
              title={path}
              aria-expanded={open}
              disabled={searching}
              onClick={() => onToggle(path)}
            >
              <ChevronRight aria-hidden="true" data-open={open} />
              <span>{label}</span>
            </button>
            {open && children(node, depth + 1)}
          </li>
        );
      })}
      {parent.files.map((file) => {
        const name = file.path.split("/").at(-1) ?? file.path;
        const Icon = /\.(png|jpe?g|gif|webp|svg)$/iu.test(name)
          ? Image
          : /\.(md|txt|log)$/iu.test(name)
            ? FileText
            : FileCode2;
        return (
          <li key={file.path} className="review-tree-file-row">
            <button
              className="session-review-file review-tree-file"
              type="button"
              style={{ paddingLeft: 8 + depth * 16 }}
              data-review-file={file.path}
              title={file.path}
              aria-label={file.path}
              aria-current={selectedPath === file.path ? "true" : undefined}
              onClick={() => onSelect(file.path)}
            >
              <Icon aria-hidden="true" className="review-tree-icon" />
              <span className="review-tree-name">{name}</span>
              <span className="session-review-stats" aria-hidden="true">
                {file.binary ? (
                  <span>{t("gitReviewBinaryShort")}</span>
                ) : file.statsUnavailable ? (
                  <span title={t("turnEditStatsUnknown")}>—</span>
                ) : (
                  <>
                    <span className="review-additions">+{file.additions}</span>
                    <span className="review-deletions">-{file.deletions}</span>
                  </>
                )}
              </span>
            </button>
            {onViewedChange && (
              <label
                className="review-viewed-control"
                title={t("gitReviewMarkViewed", { path: file.path })}
              >
                <input
                  type="checkbox"
                  aria-label={t("gitReviewMarkViewed", { path: file.path })}
                  checked={viewed?.has(file.path) ?? false}
                  disabled={viewedLimitReached && !viewed?.has(file.path)}
                  onChange={(event) =>
                    onViewedChange(file.path, event.currentTarget.checked)
                  }
                />
              </label>
            )}
          </li>
        );
      })}
    </ul>
  );
  return (
    <div className="session-review-list review-file-tree">
      {children(root, 0)}
    </div>
  );
}
