import { z } from 'zod';
import type { Queryable } from '../../infra/db.js';
import { ValidationError } from '../../domain/errors.js';

/** Fields a shop defines per category: the facts a product of that kind has (specs), and the choices a shopper makes (options). */
export const AttributeSchema = z.strictObject({
  label: z.string().trim().min(1).max(40),
  kind: z.enum(['text', 'number', 'choice', 'yes_no']),
  unit: z.string().trim().max(12).default(''),
  choices: z.array(z.string().trim().min(1).max(40)).max(40).default([]),
  /** The shopper picks this before buying (size, colour, storage). Each combination becomes its own product with its own stock and price. */
  isOption: z.boolean().default(false),
  required: z.boolean().default(false),
  /** Offered as a filter in the shop. */
  filterable: z.boolean().default(false),
});
export const AttributesSchema = z.strictObject({ attributes: z.array(AttributeSchema).max(30) });
export type AttributeInput = z.infer<typeof AttributeSchema>;

export const attrKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Checks a whole attribute list before it is saved. */
export function checkAttributes(list: AttributeInput[]): void {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const seen = new Set<string>();
  list.forEach((a, i) => {
    const key = attrKey(a.label);
    if (!key) issues.push({ path: ['attributes', i, 'label'], message: 'Use letters or numbers in the name' });
    else if (seen.has(key)) issues.push({ path: ['attributes', i, 'label'], message: 'Two fields have the same name' });
    seen.add(key);
    if (a.kind === 'choice' && a.choices.length < 2) issues.push({ path: ['attributes', i, 'choices'], message: 'Give at least two choices' });
    if (a.isOption && a.kind === 'yes_no') issues.push({ path: ['attributes', i, 'isOption'], message: 'A yes/no field can’t be something shoppers choose between' });
    if (a.kind !== 'choice' && a.choices.length) issues.push({ path: ['attributes', i, 'choices'], message: 'Only choice fields have a list of choices' });
    if (new Set(a.choices.map((c) => c.toLowerCase())).size !== a.choices.length) issues.push({ path: ['attributes', i, 'choices'], message: 'The same choice is listed twice' });
  });
  if (issues.length) throw new ValidationError(issues);
}

export interface AttributeRow { id: string; key: string; label: string; kind: 'text' | 'number' | 'choice' | 'yes_no'; unit: string; choices: string[]; is_option: boolean; required: boolean; filterable: boolean; position: number }

export const attributeView = (a: AttributeRow) => ({ id: a.id, key: a.key, label: a.label, kind: a.kind, unit: a.unit, choices: a.choices, isOption: a.is_option, required: a.required, filterable: a.filterable });

export async function attributesOf(c: Queryable, categoryId: string): Promise<AttributeRow[]> {
  return (await c.query<AttributeRow>('SELECT id, key, label, kind, unit, choices, is_option, required, filterable, position FROM category_attributes WHERE category_id = $1 ORDER BY position, label', [categoryId])).rows;
}

export type Values = Record<string, string | number | boolean>;

/**
 * Checks a product's specs and options against its category: required ones present, the right kind of value, choices from the list,
 * and nothing the category doesn't define. Returns the cleaned values (options all as text).
 */
export function checkValues(attrs: AttributeRow[], specs: Values, options: Values, optionsOnly = false): { specs: Values; options: Record<string, string> } {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const outSpecs: Values = {};
  const outOptions: Record<string, string> = {};
  const known = new Map(attrs.map((a) => [a.key, a]));
  for (const k of Object.keys(specs)) if (!known.get(k) || known.get(k)!.is_option) issues.push({ path: ['specs', k], message: 'This category has no such field' });
  for (const k of Object.keys(options)) if (!known.get(k) || !known.get(k)!.is_option) issues.push({ path: ['options', k], message: 'This category has no such option' });
  for (const a of attrs) {
    if (optionsOnly && !a.is_option) continue;
    const bag = a.is_option ? 'options' : 'specs';
    const raw = (a.is_option ? options : specs)[a.key];
    const blank = raw === undefined || raw === '' || raw === null;
    if (blank) {
      if (a.required || a.is_option) issues.push({ path: [bag, a.key], message: `${a.label} is required` });
      continue;
    }
    if (a.kind === 'number') {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) { issues.push({ path: [bag, a.key], message: `${a.label} must be a number` }); continue; }
      if (a.is_option) outOptions[a.key] = String(n); else outSpecs[a.key] = n;
    } else if (a.kind === 'yes_no') {
      if (typeof raw !== 'boolean') { issues.push({ path: [bag, a.key], message: `${a.label} must be yes or no` }); continue; }
      outSpecs[a.key] = raw;
    } else {
      const s = String(raw).trim();
      if (!s || s.length > 200) { issues.push({ path: [bag, a.key], message: `${a.label} must be 1 to 200 characters` }); continue; }
      if (a.kind === 'choice' && !a.choices.some((c) => c.toLowerCase() === s.toLowerCase())) { issues.push({ path: [bag, a.key], message: `${a.label} must be one of: ${a.choices.join(', ')}` }); continue; }
      const canon = a.kind === 'choice' ? a.choices.find((c) => c.toLowerCase() === s.toLowerCase())! : s;
      if (a.is_option) outOptions[a.key] = canon; else outSpecs[a.key] = canon;
    }
  }
  if (issues.length) throw new ValidationError(issues);
  return { specs: outSpecs, options: outOptions };
}
