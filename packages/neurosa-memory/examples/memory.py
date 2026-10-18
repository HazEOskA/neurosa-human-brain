"""Przykład backendowy: istniejący Brain API, bez zależności i bez wywołań modeli."""
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid

endpoint = os.environ["NEUROSA_API_URL"].rstrip("/")
parsed = urllib.parse.urlsplit(endpoint)
if parsed.username or parsed.password or parsed.query or parsed.fragment:
    raise ValueError("Nieprawidłowy endpoint NeurOSA")
if parsed.scheme != "https" and not (
    parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")
):
    raise ValueError("Zdalna NeurOSA wymaga HTTPS")
brain_id = os.environ.get("NEUROSA_BRAIN_ID", "OsaBrain")
namespace = os.environ.get("NEUROSA_MEMORY_NAMESPACE", "osa")
scope = {
    "organizationId": os.environ.get("NEUROSA_ORGANIZATION_ID", namespace),
    "projectId": os.environ.get("NEUROSA_PROJECT_ID", namespace),
    "namespace": namespace,
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(NoRedirect())


def request(path, body=None):
    headers = {
        "Authorization": "Bearer " + os.environ["NEUROSA_API_TOKEN"],
        "Content-Type": "application/json",
        "x-neurosa-brain-id": brain_id,
        "x-neurosa-organization-id": urllib.parse.quote(scope["organizationId"], safe=""),
        "x-neurosa-project-id": urllib.parse.quote(scope["projectId"], safe=""),
        "x-neurosa-namespace": urllib.parse.quote(scope["namespace"], safe=""),
    }
    req = urllib.request.Request(endpoint + "/api/v1/" + path, headers=headers,
                                 data=None if body is None else json.dumps(body).encode())
    with opener.open(req, timeout=15) as response:
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Odpowiedź NeurOSA przekracza 1 MiB")
        return json.loads(raw)


def check_binding(result):
    if result.get("brainId") != brain_id or result.get("ledgerValid") is not True or result.get("memoryScope") != scope:
        raise ValueError("Odrzucono brain, ledger lub scope")


def health():
    result = request("brain/status")
    check_binding(result)
    return result


def remember(agent_id, content, idempotency_key):
    health()
    result = request("brain/remember", {
        "title": "Pamięć (" + agent_id + ")", "content": content,
        "originAgentId": agent_id, "projectId": scope["projectId"],
        "idempotencyKey": idempotency_key,
    })
    check_binding(result)
    document = result["document"]
    if document["content"] != content or hashlib.sha256(document["content"].encode()).hexdigest() != document["contentHash"]:
        raise ValueError("Niespójny hash zapisu")
    return result


def recall(agent_id, query):
    # agent_id to provenance hosta; uprawnienia pochodzą wyłącznie z tokenu.
    result = request("brain/recall", {"query": query, "includeCore": True, "maxChars": 12000})
    check_binding(result)
    checked = []
    for ref in result["references"]:
        document = request("documents/" + urllib.parse.quote(ref["documentId"], safe=""))
        # JS offsets liczone są w jednostkach UTF-16, także dla znaków spoza BMP.
        encoded = document["content"].encode("utf-16-le")
        start = ref["offset"] * 2
        length = len(ref["excerpt"].encode("utf-16-le", errors="surrogatepass"))
        if (document["documentId"] != ref["documentId"] or document["revision"] != ref["revision"]
                or document["contentHash"] != ref["contentHash"]
                or hashlib.sha256(document["content"].encode()).hexdigest() != ref["contentHash"]
                or encoded[start:start + length].decode("utf-16-le", errors="surrogatepass") != ref["excerpt"]):
            raise ValueError("Niespójny dokument źródłowy")
        checked.append({"documentId": ref["documentId"], "contentHash": ref["contentHash"], "content": ref["excerpt"]})
    return {"untrusted": True, "sources": checked, "brainId": brain_id,
            "operationId": result["operationId"], "ledger": "SERVER_VALIDATED"}


if __name__ == "__main__":
    # Uruchom tylko w autoryzowanym środowisku testowym; ten fragment wykonuje zapis.
    key = str(uuid.uuid4())
    remember("jeverson", "PythonProof: użytkownik buduje system OSA", key)
    print(json.dumps(recall("hermes", "PythonProof"), ensure_ascii=False))
