import * as path from 'node:path';

export type ArtifactType =
  | 'research'
  | 'brainstorm'
  | 'plan'
  | 'fleet'
  | 'solution'
  | 'changelog'
  | 'todo'
  | 'design'
  | 'docs';

export function classifyArtifact(filePath: string): ArtifactType {
  const normalized = filePath.replaceAll(path.sep, '/').toLowerCase();
  if (/(?:^|\/)docs\/research\//.test(normalized)) {
    return 'research';
  }
  if (/(?:^|\/)docs\/brainstorms\//.test(normalized)) {
    return 'brainstorm';
  }
  if (/(?:^|\/)(?:docs\/)?plans\//.test(normalized)) {
    return 'plan';
  }
  if (/(?:^|\/)docs\/fleet\//.test(normalized)) {
    return 'fleet';
  }
  if (/(?:^|\/)docs\/solutions\//.test(normalized)) {
    return 'solution';
  }
  if (/(?:^|\/)docs\/changelog\.mdx?$/.test(normalized)) {
    return 'changelog';
  }
  if (/(?:^|\/)todos(?:\/|\.mdx?$)/.test(normalized)) {
    return 'todo';
  }
  if (/(?:^|\/)design\.mdx?$/.test(normalized)) {
    return 'design';
  }
  return 'docs';
}

export function artifactTypeLabel(type: ArtifactType): string {
  switch (type) {
    case 'research':
      return 'research';
    case 'brainstorm':
      return 'brainstorm';
    case 'plan':
      return 'plan';
    case 'fleet':
      return 'fleet';
    case 'solution':
      return 'solution';
    case 'changelog':
      return 'changelog';
    case 'todo':
      return 'todo';
    case 'design':
      return 'design';
    case 'docs':
      return 'docs';
  }
}
