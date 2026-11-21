import { Type, type Static, type TSchema } from '@sinclair/typebox';

/**
 * Nullable primitive schema as `type: [T, 'null']`.
 *
 * Fastify validates with AJV's type coercion enabled; inside an `anyOf` union the first
 * branch coerces `null` to `0` / `""` / `false` and succeeds, silently replacing a null.
 * With a type array AJV only coerces when the value matches none of the types.
 */
export function Nullable<T extends TSchema>(schema: T) {
  const { type, ...rest } = schema as unknown as { type: string };
  return Type.Unsafe<Static<T> | null>({ ...rest, type: [type, 'null'] });
}
