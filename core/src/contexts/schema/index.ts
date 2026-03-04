export type SchemaHandler = () => Record<string, unknown>;

declare module '#core/context' {
  interface ContextHandlers {
    schema: SchemaHandler;
  }
}