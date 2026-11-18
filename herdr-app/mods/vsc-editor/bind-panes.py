"""Attach each file mod's real pane ID to its persisted props via Herdr's document API.

The app supplies pane IDs to headers, but not to pane content mods. Only this
metadata field is changed; compare-and-swap preserves concurrent layout edits.
"""
import copy
import json
import subprocess
import sys


def rpc(method, params):
    request = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    result = subprocess.run(["hc", "connect"], input=json.dumps(request) + "\n", text=True,
                            capture_output=True, timeout=20)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Could not connect to Herdr core")
    messages = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    replies = [message for message in messages if message.get("id") == 1]
    if len(replies) != 1:
        raise ValueError("Herdr returned no unique document response")
    return replies[0]


def patch_document(value):
    if not isinstance(value, dict) or not isinstance(value.get("spaces"), list):
        raise ValueError("Invalid Herdr layout document: expected spaces")
    result = copy.deepcopy(value)
    changed = 0

    def walk(node):
        nonlocal changed
        if not isinstance(node, dict) or not isinstance(node.get("id"), str):
            raise ValueError("Invalid Herdr layout node")
        content = node.get("content")
        if isinstance(content, dict) and content.get("mod") == "vsc-editor":
            props = content.get("props")
            if not isinstance(props, dict) or not isinstance(props.get("file"), dict):
                raise ValueError("File pane has invalid persisted props")
            if props.get("preview_pane") != node["id"]:
                props["preview_pane"] = node["id"]
                changed += 1
        children = node.get("children", [])
        if not isinstance(children, list):
            raise ValueError("Invalid Herdr layout children")
        for child in children:
            walk(child)

    for space in result["spaces"]:
        if not isinstance(space, dict) or not isinstance(space.get("tabs"), list):
            raise ValueError("Invalid Herdr Space document")
        for tab in space["tabs"]:
            if not isinstance(tab, dict) or not isinstance(tab.get("root"), dict):
                raise ValueError("Invalid Herdr tab document")
            walk(tab["root"])
    return result, changed


def bind(on, call=rpc):
    if on is not None and (not isinstance(on, str) or not on):
        raise ValueError("Invalid machine for native file panes")
    for _ in range(5):
        response = call("doc.get", {"name": "herdr-app", "on": on})
        if "error" in response:
            raise RuntimeError("Cannot read Herdr layout: " + json.dumps(response["error"]))
        saved = response.get("result")
        if not isinstance(saved, dict) or type(saved.get("version")) is not int:
            raise ValueError("Herdr returned an invalid document version")
        value, changed = patch_document(saved.get("value"))
        if not changed:
            return {"bound": 0}
        reply = call("doc.set", {"name": "herdr-app", "on": on, "version": saved["version"], "value": value})
        if "error" in reply:
            if reply["error"].get("data", {}).get("kind") == "conflict":
                continue
            raise RuntimeError("Cannot attach file pane metadata: " + json.dumps(reply["error"]))
        if not isinstance(reply.get("result"), dict) or type(reply["result"].get("version")) is not int:
            raise ValueError("Herdr did not confirm the pane metadata update")
        return {"bound": changed}
    raise RuntimeError("Herdr layout kept changing; retry attaching file panes")


if __name__ == "__main__":
    try:
        print(json.dumps(bind(json.loads(sys.argv[1]).get("on"))))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
