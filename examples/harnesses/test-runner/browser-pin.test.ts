import { expect, test } from "bun:test";
import { browserPin } from "./browser-pin";

test("uses the frozen Playwright resolution for Prompt Studio's test dependency", () => {
  const e2e = { devDependencies: { "@playwright/test": "^1.60.0" } };
  const lock =
    '{"packages":{"@playwright/test":["@playwright/test@1.60.0","",{}],"playwright":["playwright@1.60.0","",{}],},}';
  expect(browserPin([{}, e2e], lock)).toBe("1.60.0");
});
test("keeps a different frozen browser version visible", () => {
  const pkg = { devDependencies: { "@playwright/test": "^1.60.0" } };
  const lock = '{"packages":{"@playwright/test":["@playwright/test@1.61.0"],"playwright":["playwright@1.61.0"]}}';
  expect(browserPin([pkg], lock)).toBe("1.61.0");
});
test("requires a lock for ranges and rejects inconsistent browser packages", () => {
  expect(browserPin([{ dependencies: { playwright: "^1.60.0" } }], "{}")).toBeUndefined();
  expect(browserPin([{ dependencies: { playwright: "1.60.0" } }], "{}")).toBe("1.60.0");
  expect(
    browserPin(
      [{ dependencies: { "@playwright/test": "1.60.0" } }],
      '{"packages":{"playwright":["playwright@1.61.0"]}}',
    ),
  ).toBeUndefined();
});

test("rejects different per-workspace frozen browser resolutions", () => {
  const pkg = { devDependencies: { "@playwright/test": "1.61.0" } };
  const lock = JSON.stringify({
    packages: {
      "@playwright/test": ["@playwright/test@1.60.0"],
      playwright: ["playwright@1.60.0"],
      "e2e/@playwright/test": ["@playwright/test@1.61.0"],
      "e2e/playwright": ["playwright@1.61.0"],
    },
  });
  expect(browserPin([pkg], lock)).toBeUndefined();
});

test("rejects a frozen browser that conflicts with the declared exact pin", () => {
  expect(
    browserPin(
      [{ devDependencies: { "@playwright/test": "1.61.0" } }],
      JSON.stringify({
        packages: { "@playwright/test": ["@playwright/test@1.60.0"], playwright: ["playwright@1.60.0"] },
      }),
    ),
  ).toBeUndefined();
});
