"""Private failure locations, without exception messages, arguments or local values."""
import logging
from pathlib import Path

_SOURCES = frozenset({"adapters.py", "authority.py", "core.py", "diagnostics.py",
                      "postgres_store.py", "private_vault.py", "provisioner.py",
                      "public.py", "quotes.py", "rpc.py", "signer_http.py"})


def log_failure_location(error):
    frame = error.__traceback__
    if frame is None:
        source, line = "unknown", 0
    else:
        while frame.tb_next is not None:
            frame = frame.tb_next
        source = Path(frame.tb_frame.f_code.co_filename).name
        source = source if source in _SOURCES else "dependency"
        line = frame.tb_lineno
    logging.getLogger(__name__).warning("Private operation failed at %s:%d", source, line)
