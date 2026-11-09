/**
 * Reading a new password at a shell (issue #364, `planning/portal-v0-spec.md` §7a).
 *
 * The recovery commands take the password from a hidden prompt, or from standard input when it is
 * piped, and never from an argument: an argument stays in shell history and in the process list,
 * which `create-admin` and `create-account` accept for a first password and a recovery must not.
 * One definition for both servers' commands, as `osUserActor` is for the actor.
 */
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

export class PasswordInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordInputError';
  }
}

/** A terminal's input stream, or a pipe's: only `isTTY` and `setRawMode` tell them apart. */
export interface PasswordInput extends Readable {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export interface PasswordIo {
  readonly input: PasswordInput;
  /** Where prompts go. The default is standard error, so a captured standard output holds nothing. */
  readonly output: Writable;
}

/**
 * Reads one line without echoing it. Enter ends it, Backspace removes the last character, Ctrl-C
 * (or Ctrl-D on an empty line) cancels. Control characters are never added to the password.
 */
function readHidden(prompt: string, io: PasswordIo): Promise<string> {
  const { input, output } = io;
  return new Promise((resolve, reject) => {
    let typed: string[] = [];
    // One decoder per prompt: a character's bytes can arrive in two reads, and decoding each read
    // alone would turn both halves into replacement characters (a password nobody can retype).
    const decoder = new StringDecoder('utf8');
    const finish = (): void => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
    };
    const onData = (chunk: Buffer | string): void => {
      for (const char of decoder.write(
        typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
      )) {
        if (char === '\r' || char === '\n') {
          finish();
          resolve(typed.join(''));
          return;
        }
        if (char === '\u0003' || (char === '\u0004' && typed.length === 0)) {
          finish();
          reject(new PasswordInputError('cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
        else if (char >= ' ') typed.push(char);
      }
    };
    output.write(prompt);
    input.setRawMode?.(true);
    input.resume();
    input.on('data', onData);
  });
}

async function readAll(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Asks for a new password twice on a terminal and returns it when both entries agree; from a pipe,
 * returns the first line of what is piped, with no confirmation (a script has nobody to ask).
 *
 * @throws PasswordInputError when the entries differ, the input is empty or the person cancels.
 *   The message never contains what was typed.
 */
export async function readNewPassword(
  io: PasswordIo = { input: process.stdin, output: process.stderr },
): Promise<string> {
  if (io.input.isTTY === true) {
    const first = await readHidden('New password: ', io);
    const second = await readHidden('Repeat it: ', io);
    if (first !== second) throw new PasswordInputError('the two entries differ');
    if (first === '') throw new PasswordInputError('the password is empty');
    return first;
  }
  const line = (await readAll(io.input)).split(/\r?\n/)[0] ?? '';
  if (line === '') throw new PasswordInputError('the password is empty');
  return line;
}
