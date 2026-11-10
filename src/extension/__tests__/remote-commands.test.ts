import { describe, expect, it } from 'vitest';
import { parseElements, SENSITIVE_FIELD, targetOf } from '../remote-commands';

describe('remote commands', () => {
  it('turns an outline into indexed elements, page-agent style', () => {
    const outline = [
      'main',
      '  heading "Sign in"',
      '  [a3] textbox "Email" (required) = "ada@example.test"',
      '  [a4] textbox "Password" (required)',
      '  [a12] button "Continue"',
      '  [ab13] checkbox "Remember me" (unchecked)',
      '  [a20] link',
    ].join('\n');
    const els = parseElements(outline);
    expect(els.map(e => e.index)).toEqual([3, 4, 12, 13, 20]);
    expect(els[0]).toMatchObject({ ref: 'a3', role: 'textbox', name: 'Email' });
    expect(els[3].ref).toBe('ab13');
    expect(els[0].line).toBe('[3] textbox "Email" (required) = "ada@example.test"');
    expect(els[2].line).toBe('[12] button "Continue"');
    expect(els[4]).toMatchObject({ role: 'link', name: '', line: '[20] link' });
  });

  it('builds the layer target from an index of the latest read, or a point', () => {
    const els = new Map(parseElements('[c7] button "Go"').map(e => [e.index, e]));
    expect(targetOf({ index: 7 }, els)).toEqual({ ref: 'c7' });
    expect(() => targetOf({ index: 8 }, els)).toThrow(/Call read first/);
    expect(() => targetOf({ index: 7 })).toThrow(/Call read first/);
    expect(() => targetOf({ selector: '#go' })).toThrow(/not supported/);
    expect(targetOf({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
    expect(targetOf({ index: 1.5 })).toBeUndefined();
    expect(targetOf({})).toBeUndefined();
  });

  it('flags password, payment and one-time-code fields', () => {
    for (const line of [
      '[4] textbox "Password"',
      '[5] textbox "Enter OTP"',
      '[6] textbox "Card number"',
      '[7] textbox "CVV"',
      '[8] textbox "Verification code"',
      '[9] textbox "Expiry date (MM/YY)"',
      '[10] textbox "PIN"',
      '[11] textbox "Token" = "••••••" (masked)',
    ])
      expect(SENSITIVE_FIELD.test(line)).toBe(true);
    for (const line of [
      '[3] textbox "Email"',
      '[12] searchbox "Search"',
      '[13] textbox "Full name"',
      '[14] textbox "Company"',
    ])
      expect(SENSITIVE_FIELD.test(line)).toBe(false);
  });
});
