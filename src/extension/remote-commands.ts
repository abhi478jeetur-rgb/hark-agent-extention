// Pure helpers of remote control (no Chrome APIs), so they can be unit-tested: the page-agent style element list,
// the target of a command, and the fields a remote agent may never type into.
import type { Target } from '@src/browser-control';

/** Field descriptions a remote agent may never type into. */
export const SENSITIVE_FIELD =
  /\bpass(word|code|phrase)?\b|\bpin\b|one[-\s]?time|\botp\b|verification code|security code|\b2fa\b|two[-\s]factor|auth(entication)? code|\bcvv2?\b|\bcvc\b|\bcsc\b|card ?number|credit card|debit card|expir(y|ation)|\biban\b|routing number|account number|\bssn\b|social security|\(masked\)|•{3,}/i;

export class RemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** One element of a `read`: the outline's ref (such as [a12], whose letters are the layer's epoch) becomes index 12. */
export interface RemoteElement {
  index: number;
  ref: string;
  role: string;
  name: string;
  line: string;
}

const LINE = /^\s*\[([a-z]+)(\d+)\]\s+([^\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/;

/** The interactive elements of a snapshot outline, page-agent style: `[12] button "Sign in"`. */
export function parseElements(outline: string): RemoteElement[] {
  const out: RemoteElement[] = [];
  for (const raw of outline.split('\n')) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const index = Number(m[2]);
    const name = m[4] ?? '';
    out.push({
      index,
      ref: `${m[1]}${index}`,
      role: m[3],
      name,
      line: `[${index}] ${m[3]}${m[4] !== undefined ? ` "${name}"` : ''}${m[5] ?? ''}`.trimEnd(),
    });
  }
  return out;
}

/**
 * The layer's target for a remote command's `index` (looked up in the latest read's elements) or `x`,`y`.
 * An index the latest read did not show is refused: refs fail closed.
 */
export function targetOf(
  args: Record<string, unknown>,
  elements?: ReadonlyMap<number, RemoteElement>,
): Target | undefined {
  if (typeof args.index === 'number' && Number.isInteger(args.index)) {
    const el = elements?.get(args.index);
    if (!el) throw new RemoteError('REF_UNKNOWN', `No element [${args.index}] in the latest read. Call read first.`);
    return { ref: el.ref };
  }
  if (typeof args.selector === 'string' && args.selector)
    throw new RemoteError(
      'UNSUPPORTED',
      'CSS selectors are not supported (the browser layer addresses only elements it has shown). Call read and use an index, or x/y from a screenshot.',
    );
  if (typeof args.x === 'number' && typeof args.y === 'number') return { x: args.x, y: args.y };
  return undefined;
}
