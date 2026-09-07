import { listenOptions } from "../../apps/brain-api/src/config.js";
import { deploymentSmoke } from "../e2e/deployment-smoke.js";

it("zachowuje lokalny domyślny nasłuch", () => {
  expect(listenOptions({})).toEqual({ host: "127.0.0.1", port: 8644, allowRemote: false });
});
it("wymaga jawnej zgody na nasłuch kontenera i obsługuje PORT", () => {
  expect(() => listenOptions({ NEUROSA_API_HOST: "0.0.0.0" })).toThrow("NEUROSA_ALLOW_REMOTE=true");
  expect(
    listenOptions({ NEUROSA_API_HOST: "0.0.0.0", NEUROSA_ALLOW_REMOTE: "true", PORT: "8080" }),
  ).toEqual({ host: "0.0.0.0", port: 8080, allowRemote: true });
  expect(listenOptions({ NEUROSA_API_PORT: "8645", PORT: "8080" }).port).toBe(8645);
});
it.each(["", "-1", "65536", "8080oops", "2.5"])("odrzuca nieprawidłowy PORT: %s", (PORT) => {
  expect(() => listenOptions({ PORT })).toThrow("numerem portu");
});
it("odrzuca literówki w ustawieniach sieci", () => {
  expect(() => listenOptions({ NEUROSA_ALLOW_REMOTE: "yes" })).toThrow("true albo false");
  expect(() => listenOptions({ NEUROSA_API_HOST: "nieznany-host" })).toThrow(
    "loopback albo wildcard",
  );
});
it("rzeczywisty entrypoint zachowuje sesję, pamięć i ledger po restarcie i SIGKILL", async () => {
  expect((await deploymentSmoke("process")).status).toBe("PASS");
}, 60000);
