import { describeDbError } from "@epnexo/core/pool";
import { Notice } from "./components.tsx";

/** The notice a page shows instead of its content when its data could not be loaded. */
export function Unavailable({ title, error }: { title: string; error: unknown }) {
  return (
    <Notice tone="error" title={title}>
      {describeDbError(error).message}
    </Notice>
  );
}
