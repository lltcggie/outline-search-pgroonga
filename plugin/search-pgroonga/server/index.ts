import { PluginManager, Hook } from "@server/utils/PluginManager";
import config from "../plugin.json";
import PGroongaSearchProvider from "./PGroongaSearchProvider";

PluginManager.add([
  {
    ...config,
    type: Hook.SearchProvider,
    value: new PGroongaSearchProvider(),
  },
]);
