/**
 * Export by file kind (v1-spec.md §3.8): the one place a project file's
 * `kind` picks its filter, so a caller (the database layer, the CLI, the
 * server) never branches on it. A separate module because both exporters
 * import this layer's `ExportError`, and the dispatch must import them.
 */

import type { ProjectFile } from '../docx/document.js';
import type { Segment } from '../model/segment.js';
import { exportProjectFile, type ExportedFile } from './export.js';
import { exportXliffFile } from './export-xliff.js';

/** Renders `file` back to its own format with the segments' targets in. */
export function exportFileBytes(
  file: ProjectFile,
  segments: readonly Segment[],
): ExportedFile {
  return file.kind === 'xliff'
    ? exportXliffFile(file, segments)
    : exportProjectFile(file, segments);
}
