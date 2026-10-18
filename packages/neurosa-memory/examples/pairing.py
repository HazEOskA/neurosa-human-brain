"""One-time pairing in the agent process; cache contains a gateway credential, not memory."""
import hashlib
import json
import os
import pathlib
import urllib.parse
import urllib.request


def configure_pairing():
    url = os.environ["NEUROSA_CONNECTOR_URL"].rstrip("/")
    parsed_url = urllib.parse.urlsplit(url)
    if (parsed_url.username or parsed_url.password or parsed_url.query or parsed_url.fragment
            or parsed_url.path or (parsed_url.scheme != "https" and not (
                parsed_url.scheme == "http" and parsed_url.hostname in ("127.0.0.1", "localhost", "::1")))):
        raise ValueError("Nieprawidłowy adres connectora")
    inputs = [url, os.environ["NEUROSA_PAIR_CODE"], os.environ["NEUROSA_AGENT_ID"]]
    key = hashlib.sha256(json.dumps(inputs, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    directory = pathlib.Path(os.environ.get("NEUROSA_CONNECT_CACHE_DIR", str(pathlib.Path.home() / ".config/neurosa/connections")))
    filename = directory / (key + ".json")

    class PairNoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    try:
        descriptor = os.open(filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        body = json.dumps({"pairingCode": inputs[1], "agentId": inputs[2]}).encode()
        request = urllib.request.Request(url + "/connect/pair/redeem", data=body, headers={"Content-Type": "application/json"})
        with urllib.request.build_opener(PairNoRedirect()).open(request, timeout=15) as response:
            raw = response.read(16001)
        if len(raw) > 16000:
            raise ValueError("Za duża odpowiedź parowania")
        connection = json.loads(raw)
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        with os.fdopen(os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
            json.dump(connection, file)
    else:
        with os.fdopen(descriptor) as file:
            if os.fstat(file.fileno()).st_size > 16000 or (os.name != "nt" and os.fstat(file.fileno()).st_mode & 0o077):
                raise ValueError("Nieprawidłowy plik połączenia")
            connection = json.load(file)
    if connection.get("endpoint") != url or not isinstance(connection.get("token"), str) or len(connection["token"]) < 24:
        raise ValueError("Odrzucono połączenie")
    for key, field in {"NEUROSA_API_URL": "endpoint", "NEUROSA_API_TOKEN": "token", "NEUROSA_BRAIN_ID": "brainId", "NEUROSA_MEMORY_NAMESPACE": "namespace", "NEUROSA_ORGANIZATION_ID": "organizationId", "NEUROSA_PROJECT_ID": "projectId"}.items():
        os.environ[key] = connection[field]


configure_pairing()
