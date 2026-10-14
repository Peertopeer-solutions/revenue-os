// Types for parse.js, which stays plain JavaScript so the tracker page can load it in the browser.
export type Item = {
  done: boolean;
  text: string;
  owner: "agent" | "Devesh";
  evidence: string;
};
export type Slice = {
  n: number;
  title: string;
  items: Item[];
  Status?: string;
  Goal?: string;
  Proof?: string;
  "Blocked by"?: string;
  "Proof passed"?: string;
};
export const STATUSES: string[];
export function passedOk(v: string | undefined): boolean;
export function plain(s: string): string;
export function sections(md: string): Record<string, string[]>;
export function parseRoadmap(md: string): {
  slices: Slice[];
  problems: string[];
};
export function parseState(md: string): {
  phase: string;
  rows: string[][];
  waiting: { done: boolean; text: string }[];
  ruleChanges: string[];
  problems: string[];
};
export function parseRecords(md: string): {
  decisions: string[];
  ruleChanges: string[];
};
export function currentSlice(slices: Slice[]): Slice | undefined;
export function nextItem(slice: Slice | undefined): Item | undefined;
