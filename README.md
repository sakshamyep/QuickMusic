# QuickMusic

A simple, high quality and stable discord music bot based on Discord.js V14 and Kazagumo.

# Features

✅ All in one command !play.

✅ Spotify direct playback.

✅ Customisable prefix.

✅ High quality and smooth playback.

✅ Simple and easy to use.

✅ Spotify, YouTube, AppleMusic, Soundcloud support.

✅ Autoplay and Lyrics feature.

✅ Albums, Artists, Playlists support.

# Requirements

1. Nodejs v20 or higher. 

2. discord.js v14.18.0

5. At least 500mb+ ram for both lavalink and bot.

6. Must enable message-content-intent from discord developers portal.

7. Must set Spotify credentials in .env

8. In order to use Spotify, AppleMusic through URL for playlists, albums make sure your lavalink has required plugins, if not then only YouTube and Soundcloud will work by default. The current lavalink given in .env supports these sources, it's recommended that you should not change it unless you have a working lavalink.

# Setup

• npm install

• add bot token, nodes in .env

• add spotify credentials in .env

• run the bot:

• node QuickMusic.js

# Usage

Use !play <song name or url> to see other commands through buttons.

You can change the prefix from .env file check for BOT_PREFIX= and set your own prefix.

Do not change search engine from Spotify to any other source as it will break autoplay feature since it is optimised for Spotify.

# License

This project is licensed under the MIT License. Attribution is required—please provide credit in your project’s README or bot description.

# Changelog v1.7

1. Added shuffle feature.
2. Added grab song feature.
3. Added clearqueue feature.
4. Added button restrictions.
5. Added stats button in help cmd.
6. Improved now playing embed.
7. Mention regex support.
8. Removed undefined player calls.
