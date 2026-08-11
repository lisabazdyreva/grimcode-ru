import type { AnyTRPCRouter, inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { type TRPCProcedureBuilder, type TRPCUnsetMarker } from '@trpc/server';
import type { z } from 'zod';

/**
 * A builder that has not been given an input or an output yet.
 *
 * It has to be described exactly like this, through the exported types. Declaring the parameter as
 * `any`, or as something more general, loses the context a middleware added — and `ctx.admin`
 * stops existing inside the resolver, silently, with the code still compiling.
 */
type FreshBuilder<TCtx, TMeta, TCtxOverrides> = TRPCProcedureBuilder<
  TCtx,
  TMeta,
  TCtxOverrides,
  TRPCUnsetMarker,
  TRPCUnsetMarker,
  TRPCUnsetMarker,
  TRPCUnsetMarker,
  false
>;

/** One procedure of a contract: what goes in, what comes out. */
export interface ContractProcedure {
  input: z.ZodType;
  output: z.ZodType;
}

export type ContractGroup = Record<string, ContractProcedure>;

/**
 * A procedure with `.input()` and `.output()` already taken from the contract.
 *
 * tRPC has no notion of implementing a contract, so the schemas have to arrive from the contract
 * by construction rather than by being written out again next to the resolver. The library this
 * template used before did check a router against its contract, and this is what replaces that.
 *
 * It is stricter than a lint rule, and for a reason a lint rule cannot match: a comment turns a
 * lint rule off, and nothing turns this off. It refuses to compile on an output that is not the
 * contract's shape, on a missing field in that output, on reading an input field the schema does
 * not have, on touching a middleware's context from a public builder, and on a builder that was
 * already given an input.
 */
export function fromContract<
  TCtx,
  TMeta,
  TCtxOverrides,
  TIn extends z.ZodType,
  TOut extends z.ZodType,
>(
  contract: { input: TIn; output: TOut },
  builder: FreshBuilder<TCtx, TMeta, TCtxOverrides>,
): TRPCProcedureBuilder<
  TCtx,
  TMeta,
  TCtxOverrides,
  z.input<TIn>,
  z.output<TIn>,
  z.input<TOut>,
  z.output<TOut>,
  false
> {
  /*
   * The one cast in this file, and it is about declaration files rather than about types.
   *
   * What `.input().output()` actually returns is the same builder parameterised through tRPC's own
   * `inferParser`, which lives in a module marked do-not-import and cannot be named from a
   * published `.d.ts` — `shared` is a package, so its types have to be nameable from outside it.
   * For any concrete Zod schema `inferParser<T>['in' | 'out']` and `z.input<T> | z.output<T>` are
   * the same type; the compiler simply cannot prove that while `T` is still generic.
   *
   * So the signature above is the honest description and this bridges to it. Nothing is widened:
   * every check the helper exists for is performed against the annotation, by the caller.
   */
  return builder.input(contract.input).output(contract.output) as unknown as TRPCProcedureBuilder<
    TCtx,
    TMeta,
    TCtxOverrides,
    z.input<TIn>,
    z.output<TIn>,
    z.input<TOut>,
    z.output<TOut>,
    false
  >;
}

/** Strict equality of two types, rather than mutual assignability. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The names where the router and the contract disagree: missing, extra, or the wrong schemas. */
type Divergence<C extends ContractGroup, R extends AnyTRPCRouter> =
  | {
      [K in keyof C]: K extends keyof inferRouterInputs<R>
        ? Equal<z.input<C[K]['input']>, inferRouterInputs<R>[K]> extends true
          ? Equal<z.output<C[K]['output']>, inferRouterOutputs<R>[K]> extends true
            ? never
            : K
          : K
        : K;
    }[keyof C]
  | Exclude<keyof inferRouterInputs<R>, keyof C>;

/**
 * "This router implements this contract, exactly."
 *
 * `fromContract` checks procedures one at a time and knows nothing about the router around them, so
 * four things compile happily without this: a contract procedure nobody implemented, a procedure
 * the contract never mentioned, the right name carrying another procedure's schemas, and a schema
 * written out by hand instead of taken from the contract.
 *
 * Called once per router. The return value **must** be assigned to the type `'ok'` — otherwise it
 * checks nothing at all:
 *
 *     const usersCoverage: 'ok' = contractCoverage(usersContract.admin, adminRouter);
 *
 * On a disagreement it fails to compile and names the procedure in the error text.
 */
export function contractCoverage<C extends ContractGroup, R extends AnyTRPCRouter>(
  _contract: C,
  _router: R,
): Divergence<C, R> extends never ? 'ok' : Divergence<C, R> {
  return 'ok' as Divergence<C, R> extends never ? 'ok' : Divergence<C, R>;
}
