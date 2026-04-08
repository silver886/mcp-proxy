import { PACKAGE_NAME, PACKAGE_VERSION } from "../generated.js";
import { json } from "../lib.js";

export const onRequestGet: PagesFunction = async () => {
  return json({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });
};
