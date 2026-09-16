"""A RAPP agent the way the grail loads them: BasicAgent subclass, OpenAI function schema, perform()."""
import os

from agents.basic_agent import BasicAgent
from utils.azure_file_storage import AzureFileStorageManager


class EchoAgent(BasicAgent):
    def __init__(self):
        self.name = "Echo"
        self.metadata = {
            "name": self.name,
            "description": "Echoes the text back, upper-cased. Use when the user asks to echo or shout something.",
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string", "description": "What to echo."}},
                "required": ["text"],
            },
        }
        self.storage = AzureFileStorageManager()
        super().__init__(self.name, self.metadata)

    def perform(self, text="", **kwargs):
        print("stdout noise that must not corrupt the JSON line")
        guid = os.environ.get("BRAINSTEM_USER_GUID", "")
        return f"ECHO: {text.upper()}" + (f" (for {guid})" if guid else "")
