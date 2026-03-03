from telethon.sync import TelegramClient
from telethon.sessions import StringSession

api_id = int(input("API ID: ").strip())
api_hash = input("API HASH: ").strip()
phone = input("PHONE: ").strip()

with TelegramClient(StringSession(), api_id, api_hash) as client:
    client.start(phone=phone)
    print("SESSION_STRING:", client.session.save())
