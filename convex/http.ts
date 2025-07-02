import { httpRouter } from "convex/server";
import { getLunch } from "./forkable";

const http = httpRouter();

http.route({
  path: "/forkable",
  method: "GET",
  handler: getLunch,
});

export default http;
