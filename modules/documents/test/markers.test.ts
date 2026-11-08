import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLATFORM_MARKERS, escapeHtml, listMarkers, malformedMarkers, markerSpans, splitMarkers, substitute } from "../src/markers.ts";

describe("listMarkers", () => {
  it("lists the distinct markers in order of first appearance", () => {
    assert.deepEqual(listMarkers("<p>{{B_NOMBRE}} y {{A_NOMBRE}}</p><p>{{B_NOMBRE}} {{REF}}</p>"), ["B_NOMBRE", "A_NOMBRE", "REF"]);
  });

  it("returns an empty list for a body without markers", () => {
    assert.deepEqual(listMarkers("<p>Nothing to fill</p>"), []);
    assert.deepEqual(listMarkers(""), []);
  });

  it("accepts digits and a leading underscore, like the skill's names plus numbers", () => {
    assert.deepEqual(listMarkers("{{PARTY_2}} {{_X}} {{N1}}"), ["PARTY_2", "_X", "N1"]);
  });

  it("does not treat lowercase names, spaces, empty or unclosed braces as markers", () => {
    assert.deepEqual(listMarkers("{{name}} {{ NAME }} {{}} {{A-B}} {{OPEN} {{UNCLOSED"), []);
  });

  it("finds a marker inside surrounding braces and next to another marker", () => {
    assert.deepEqual(listMarkers("{{{A}}} {{B}}{{C}}"), ["A", "B", "C"]);
  });

  it("finds markers inside a style block and inside attributes", () => {
    assert.deepEqual(listMarkers('<style>@page { size: {{PAGINA}}; }</style><i title="{{T}}"></i>'), ["PAGINA", "T"]);
  });
});

describe("malformedMarkers", () => {
  it("reports closed double-brace groups that are not valid markers, once each", () => {
    assert.deepEqual(malformedMarkers("{{ NAME }} {{name}} {{}} {{A-B}} {{ NAME }} {{OK}}"), ["{{ NAME }}", "{{name}}", "{{}}", "{{A-B}}"]);
  });

  it("reports nothing for valid markers or for a body without double braces", () => {
    assert.deepEqual(malformedMarkers("{{A}} {{B_2}} a { b } c"), []);
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that matter in text and attributes", () => {
    assert.equal(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`), "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;");
  });
});

describe("substitute", () => {
  it("replaces every occurrence of a marker", () => {
    const result = substitute("{{A}} and {{A}}", { A: "one" });
    assert.deepEqual(result, { html: "one and one", missing: [] });
  });

  it("escapes every value", () => {
    const result = substitute("<p>{{NAME}}</p>", { NAME: `<script>alert("x")</script> & co` });
    assert.equal(result.html, "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co</p>");
  });

  it("keeps the body's own markup untouched", () => {
    assert.equal(substitute('<b class="x">{{A}}</b>', { A: "1" }).html, '<b class="x">1</b>');
  });

  it("reports markers without a value, once each, and leaves them visible instead of printing undefined", () => {
    const result = substitute("{{A}} {{B}} {{B}} {{C}}", { A: "1" });
    assert.deepEqual(result.missing, ["B", "C"]);
    assert.equal(result.html, "1 {{B}} {{B}} {{C}}");
    assert.doesNotMatch(result.html, /undefined|null/);
  });

  it("accepts an empty string as a value", () => {
    assert.deepEqual(substitute("a{{X}}b", { X: "" }), { html: "ab", missing: [] });
  });

  it("does not substitute markers that appear inside a value", () => {
    const result = substitute("{{A}} {{B}}", { A: "{{B}}", B: "b" });
    assert.equal(result.html, "{{B}} b");
  });

  it("treats a non-string value as missing", () => {
    const result = substitute("{{A}} {{B}}", { A: undefined, B: null } as unknown as Record<string, string>);
    assert.deepEqual(result.missing, ["A", "B"]);
  });

  it("ignores values for markers the body does not have", () => {
    assert.deepEqual(substitute("{{A}}", { A: "1", Z: "9" }), { html: "1", missing: [] });
  });

  it("leaves malformed groups as they are", () => {
    assert.deepEqual(substitute("{{ A }} {{A}}", { A: "1" }), { html: "{{ A }} 1", missing: [] });
  });
});

describe("splitMarkers", () => {
  it("separates markers the profile has from the ones asked for each document", () => {
    const groups = splitMarkers(["A_NOMBRE", "B_NOMBRE", "COLOR"], { A_NOMBRE: "Epnexo", COLOR: "#112233", UNUSED: "x" });
    assert.deepEqual(groups, { fromProfile: ["A_NOMBRE", "COLOR"], perDocument: ["B_NOMBRE"] });
  });

  it("never asks for the reference: the platform fills REF from the number it takes", () => {
    assert.deepEqual(splitMarkers(["B_NOMBRE", "REF"], {}), { fromProfile: [], perDocument: ["B_NOMBRE"] });
    assert.deepEqual([...PLATFORM_MARKERS], ["REF"]);
  });

  it("keeps the order of the markers it is given", () => {
    assert.deepEqual(splitMarkers(["Z", "A", "M"], { M: "1", Z: "2" }), { fromProfile: ["Z", "M"], perDocument: ["A"] });
  });

  it("sends everything to the document group when the profile is empty", () => {
    assert.deepEqual(splitMarkers(["A", "B"], {}), { fromProfile: [], perDocument: ["A", "B"] });
  });

  it("does not count inherited properties as profile keys", () => {
    assert.deepEqual(splitMarkers(["constructor"], {}), { fromProfile: [], perDocument: ["constructor"] });
  });
});

describe("markerSpans", () => {
  it("gives every valid marker with where it sits, repeats included", () => {
    assert.deepEqual(markerSpans("a {{X}} b {{Y_1}}{{X}}"), [
      { name: "X", start: 2, end: 7 },
      { name: "Y_1", start: 10, end: 17 },
      { name: "X", start: 17, end: 22 },
    ]);
  });

  it("skips what listMarkers skips", () => {
    assert.deepEqual(markerSpans("{{x}} {{ X }} {{}} {{OPEN}"), []);
  });
});
