"""Fixed Vercel bootstrap. No request can select paths, runtimes or credentials."""
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-runner"))
os.environ["VERDICT_NODE_BINARY"] = str(ROOT / "runtime" / "node")

# Explicit tracing anchors keep transitive Python/native files in subprocesses.
# Importing these modules does not allocate a venue client, account key or grant.
import certifi
import Crypto.Cipher.AES
import eth_account
import lighter
import psycopg
import pydantic

from verdict_broker.signer_http import VercelHandler

class handler(VercelHandler):
    pass
