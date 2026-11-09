import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  PasswordInputError,
  readNewPassword,
  type PasswordInput,
} from './shell-password.js';

/** A terminal that types `lines` one at a time, each when a prompt is written. */
function terminal(lines: readonly string[]) {
  const input = new PassThrough() as PassThrough & PasswordInput;
  input.isTTY = true;
  const raw: boolean[] = [];
  input.setRawMode = (mode: boolean) => {
    raw.push(mode);
    return input;
  };
  const output = new PassThrough();
  const shown: string[] = [];
  let next = 0;
  output.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    shown.push(text);
    if (text.endsWith(': ')) {
      const line = lines[next++] ?? '';
      setImmediate(() => input.write(line));
    }
  });
  return { input, output, shown, raw };
}

describe('readNewPassword (issue #364)', () => {
  it('reads two matching entries from a terminal and never echoes them', async () => {
    const t = terminal(['correct horse battery\r', 'correct horse battery\r']);
    const password = await readNewPassword({ input: t.input, output: t.output });
    expect(password).toBe('correct horse battery');
    // Only prompts and newlines were written; the typed text never was.
    expect(t.shown.join('')).not.toContain('correct');
    // Raw mode was switched on for each prompt and left off.
    expect(t.raw).toEqual([true, false, true, false]);
  });

  it('honours Backspace and ignores control characters', async () => {
    const t = terminal(['abcxx\u007f\u007fdef\u001b\r', 'abcdef\r']);
    await expect(readNewPassword({ input: t.input, output: t.output })).resolves.toBe(
      'abcdef',
    );
  });

  it('refuses two entries that differ, without naming either', async () => {
    const t = terminal(['first-entry-here\r', 'other-entry-here\r']);
    const error = await readNewPassword({ input: t.input, output: t.output }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PasswordInputError);
    expect((error as Error).message).toBe('the two entries differ');
  });

  it('cancels on Ctrl-C', async () => {
    const t = terminal(['abc\u0003']);
    await expect(readNewPassword({ input: t.input, output: t.output })).rejects.toThrow(
      'cancelled',
    );
  });

  it('takes the first line of a pipe, with no confirmation', async () => {
    const input = new PassThrough() as PassThrough & PasswordInput;
    input.end('piped password here\nignored second line\n');
    const password = await readNewPassword({ input, output: new PassThrough() });
    expect(password).toBe('piped password here');
  });

  it('refuses an empty pipe', async () => {
    const input = new PassThrough() as PassThrough & PasswordInput;
    input.end('\n');
    await expect(readNewPassword({ input, output: new PassThrough() })).rejects.toThrow(
      'the password is empty',
    );
  });
});
