import { getDb } from "@modunexo/sdk";
import { importNdaFromRequest } from "./submit-import.ts";

/** The Import NDA form. The gate has already required `documents.write`. */
export const POST = (request: Request): Promise<Response> => importNdaFromRequest(request, () => getDb("documents"));
