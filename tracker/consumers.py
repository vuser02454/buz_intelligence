"""
WebSocket Chat Consumer for Dual-AI Intelligence System (Gemini + Grok).
"""

import json
import logging
from asgiref.sync import sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer

from tracker.ai.orchestrator import process_user_query

logger = logging.getLogger(__name__)


def get_bot_response(message: str, chat_session=None, location_context=None) -> str:
    """
    Backward-compatible entry point returning merged response text.
    """
    result = process_user_query(message, client_location_context=location_context)
    return result.get("message", "I am unable to process that query at this time.")


class ChatConsumer(AsyncWebsocketConsumer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.session_context = {}

    async def connect(self):
        await self.accept()
        logger.info("ChatConsumer: WebSocket connection accepted.")

    async def disconnect(self, close_code):
        logger.info(f"ChatConsumer: WebSocket disconnected ({close_code}).")

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
            user_message = (data.get("message") or "").strip()
            client_location = data.get("location") or self.session_context.get("location")
            
            if not user_message:
                await self.send(text_data=json.dumps({
                    "success": False,
                    "message": "Please enter a message or location to analyze.",
                    "structured_actions": []
                }))
                return

            if client_location and isinstance(client_location, dict):
                self.session_context["location"] = client_location

            logger.info(f"ChatConsumer [WS]: Processing user query '{user_message[:40]}' with location context...")
            
            # Execute the Dual-AI Orchestrator
            result = await sync_to_async(process_user_query)(
                user_message,
                client_location_context=client_location
            )
            
            # Update session context with resolved location if available
            if result.get("location_context"):
                self.session_context["location"] = result["location_context"].get("location")

            await self.send(text_data=json.dumps({
                "success": result.get("success", True),
                "message": result.get("message", ""),
                "structured_actions": result.get("structured_actions", []),
                "location_context": result.get("location_context"),
                "providers_used": result.get("providers_used", [])
            }))
            
        except json.JSONDecodeError:
            await self.send(text_data=json.dumps({
                "success": False,
                "message": "Invalid message format.",
                "structured_actions": []
            }))
        except Exception as e:
            logger.error(f"ChatConsumer exception: {e}", exc_info=True)
            await self.send(text_data=json.dumps({
                "success": False,
                "message": f"Sorry, an error occurred while processing your request: {str(e)}",
                "structured_actions": []
            }))
