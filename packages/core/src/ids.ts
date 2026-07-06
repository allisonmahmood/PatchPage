import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newDraftId(): string {
  return randomId(12);
}

export function newInternalId(prefix = "id"): string {
  return `${prefix}_${randomId(24)}`;
}

export function isDraftId(value: string): boolean {
  return /^[a-z0-9]{12}$/.test(value);
}

function randomId(length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += ALPHABET[randomInt(ALPHABET.length)];
  }
  return value;
}
