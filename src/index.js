/*
Copyright 2025 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

/// <reference types="@fastly/js-compute" />

import * as response from './lib/response.js';
import { log } from './lib/log.js';
import { weatherHandler } from "./weather.js";
import { Backend } from "fastly:backend";
import { contactBackendOptions } from "./lib/contact-http.js";
import { contactFormHandler } from "./contact-form.js";
import { CONTACT_FORM_CONFIG } from "./contact-form-config.local.js";

addEventListener("fetch", (event) => event.respondWith(handleRequest(event)));

async function handleRequest(event) {
  const req = event.request;
  const url = new URL(req.url);

  let finalResponse;

  try {
    // Route matching
    if (url.pathname === "/" && req.method === "GET") {
      finalResponse = new Response("Hello World from the edge!", { status: 200 });
    } else if (url.pathname === "/hello-worlds" && req.method === "GET") {
      // fetch param name from request
      const name = url.searchParams.get("name") || "Nishant";
      // dont cache the response at CDN
      const headers = new Headers();
      headers.set("Cache-Control", "no-store");
      headers.set("Content-Type", "text/html");

      finalResponse = new Response(`<html><body>Hello World ${name} from the edge!</body></html>`, { status: 200, headers });
    } else if (url.pathname === "/api/form/contact-form") {
      finalResponse = await contactFormHandler(req, {
        config: CONTACT_FORM_CONFIG,
        fetch: (request) => fetch(request, {
          backend: new Backend(contactBackendOptions(request.url)),
        }),
      });
    } else if (url.pathname === "/weather" && req.method === "GET") {
      finalResponse = await weatherHandler(req, event.client);
    } else {
      finalResponse = response.notFound();
    }
  } catch (err) {
    console.log(err);
    finalResponse = response.error();
  }

  // Log the request and response
  log(req, finalResponse);

  return finalResponse;
}
