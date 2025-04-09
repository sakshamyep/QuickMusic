/**
 * QuickMusic | v1.2
 * Copyright (c) 2025 Saksham Pandey
 */
import "dotenv/config";
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType } from "discord.js";
import { Kazagumo } from "kazagumo";
import { Connectors } from "shoukaku";
import axios from "axios";

class Music {
  constructor() {
    this.config = {};
  };
};

class QuickMusic extends Music {
  constructor() {
    super();
    this.config = {
      token: process.env.TOKEN,
      prefix: process.env.BOT_PREFIX,
      lavalink: {
        name: process.env.LAVALINK_NAME,
        url: process.env.LAVALINK_URL,
        auth: process.env.LAVALINK_AUTH,
        secure: process.env.LAVALINK_SECURE === "true",
      },
      botActivity: {
        type: process.env.BOT_ACTIVITY_TYPE || "LISTENING",
        message: process.env.BOT_ACTIVITY_MESSAGE || `${process.env.BOT_PREFIX}play`,
      },
    };

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      allowedMentions: { repliedUser: false },
      cache: {
        messages: false,
        channels: false,
        guilds: false,
        users: false,
      },
    });

    this.kazagumo = new Kazagumo(
      {
        defaultSearchEngine: "youtube_music",
        send: (guildId, payload) => {
          const guild = this.client.guilds.cache.get(guildId);
          if (guild) guild.shard.send(payload);
        },
        options: {
          bufferTimeout: 1000,
          maxRetries: 5,
          retryDelay: 2000,
        },
      },
      new Connectors.DiscordJS(this.client),
      [{
        ...this.config.lavalink,
        retryCount: 5,
        retryDelay: 2000,
      }]
    );

    this.nowPlayingMessages = new Map();
    this.isProcessingTrack = false;
    this.isSkipping = false;
    this.autoplayStates = new Map();
    this.lastPlayedTracks = new Map();
    this.sessionPlayedTracks = new Map();
  };

  getActivityTypeWrapper(type) {
    const types = {
      PLAYING: ActivityType.Playing,
      LISTENING: ActivityType.Listening,
      WATCHING: ActivityType.Watching,
      COMPETING: ActivityType.Competing,
    };
    return types[type.toUpperCase()] || ActivityType.Listening;
  };

  createEmbed(title, description) {
    return new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor("#FFFFFF");
  };

  getControlButtons(isPaused = false, isAutoplayEnabled = false) {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("pause")
        .setLabel(isPaused ? "Resume" : "Pause")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("stop")
        .setLabel("Stop")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("skip")
        .setLabel("Skip")
        .setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("loop")
        .setLabel("Loop")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("queue")
        .setLabel("Queue")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("autoplay")
        .setLabel("Autoplay")
        .setStyle(ButtonStyle.Secondary)
    );
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("vol_down")
        .setLabel("Vol -")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("lyrics")
        .setLabel("Lyrics")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("vol_up")
        .setLabel("Vol +")
        .setStyle(ButtonStyle.Secondary)
    );
    return [row1, row2, row3];
  };

  async deleteOldNowPlaying(player) {
    const oldMsg = this.nowPlayingMessages.get(player.guildId);
    if (oldMsg) {
      try {
        await oldMsg.delete();
      } catch (err) {
        return;
      };
      this.nowPlayingMessages.delete(player.guildId);
    };
  };

  async sendNowPlayingEmbed(player) {
    if (this.isProcessingTrack || player.destroyed) return;
    this.isProcessingTrack = true;
    try {
      const channel = this.client.channels.cache.get(player.textId);
      if (!channel || !player.queue.current) return;
      await this.deleteOldNowPlaying(player);
      const isAutoplayEnabled = this.autoplayStates.get(player.guildId) || false;
      const embed = this.createEmbed(
        "Now Playing",
        `[${player.queue.current.title}](${player.queue.current.uri}) - <@${player.queue.current.requester?.id || this.client.user.id}>`
      );
      const msg = await channel.send({
        embeds: [embed],
        components: this.getControlButtons(player.paused, isAutoplayEnabled),
      });
      this.nowPlayingMessages.set(player.guildId, msg);
    } catch (err) {
      return;
    } finally {
      this.isProcessingTrack = false;
    };
  };

  async fetchLyrics(title, artist) {
    const fetchWithTimeout = async (url, timeout = 10000) => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await axios.get(url, { signal: controller.signal });
        clearTimeout(id);
        return response;
      } catch (err) {
        clearTimeout(id);
        throw err;
      };
    };
    try {
      let cleanTitle = title.replace(/\([^)]*\)|\[[^\]]*\]/g, "").trim();
      cleanTitle = cleanTitle.replace(/feat\.|ft\./i, "").trim();
      const response = await fetchWithTimeout(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist || "")}/${encodeURIComponent(cleanTitle)}`);
      if (response.data && response.data.lyrics) {
        let lyrics = response.data.lyrics;
        if (lyrics.length > 4000) {
          lyrics = lyrics.substring(0, 4000) + "...\n\n(Lyrics truncated due to length)";
        };
        return lyrics;
      };
      throw new Error("No lyrics found.");
    } catch (error) {
      try {
        const geniusResponse = await fetchWithTimeout(`https://some-lyrics-api.com/search?q=${encodeURIComponent(title)}`);
        if (geniusResponse.data && geniusResponse.data.lyrics) {
          return geniusResponse.data.lyrics;
        };
      } catch (err) {
        return null;
      };
      return null;
    };
  };

  async addRelatedTrack(player) {
    const guildId = player.guildId;
    const lastTrack = this.lastPlayedTracks.get(guildId) || player.queue.current;
    if (!lastTrack) return;

    const primaryArtist = lastTrack.author ? lastTrack.author.split(",")[0].trim() : "";
    let query = primaryArtist ? `${primaryArtist} similar songs` : `${lastTrack.title} similar songs`;
    query += " -live -remix";

    const sessionPlayed = this.sessionPlayedTracks.get(guildId) || [];
    let relatedTracks = await this.kazagumo.search(query, { searchEngine: "youtube_music", limit: 20 });

    if (!relatedTracks.tracks.length) {
      query = `${lastTrack.title.split("(")[0].trim()} related songs`;
      relatedTracks = await this.kazagumo.search(query, { searchEngine: "youtube_music", limit: 20 });
    };

    if (relatedTracks.tracks.length > 0) {
      const currentUri = lastTrack.uri;
      const currentDuration = lastTrack.length || 0;
      const filteredTracks = relatedTracks.tracks
        .filter(track => 
          track.uri !== currentUri &&
          !sessionPlayed.includes(track.uri) &&
          Math.abs((track.length || 0) - currentDuration) < 90000
        )
        .slice(0, 10);

      const tracksToUse = filteredTracks.length ? filteredTracks : relatedTracks.tracks.filter(track => track.uri !== currentUri && !sessionPlayed.includes(track.uri));
      if (!tracksToUse.length) return;
      const track = tracksToUse[Math.floor(Math.random() * tracksToUse.length)];
      track.requester = this.client.user;
      player.queue.add(track);
      sessionPlayed.push(track.uri);
      this.sessionPlayedTracks.set(guildId, sessionPlayed);
      if (!player.playing && player.queue.length === 1) {
        try {
          await player.play();
        } catch (err) {
          return;
        };
      };
    };
  };

  async preloadNextTrack(player) {
    if (player.queue.length > 0 && !player.queue[0].isPreloaded) {
      try {
        const nextTrack = player.queue[0];
        const node = this.kazagumo.shoukaku.getNode();
        await node.decode(nextTrack.uri, { force: true });
        nextTrack.isPreloaded = true;
      } catch (err) {
        console.error("Preload Error:", err);
        return;
      };
    };
  };

  handleVoiceStateUpdate(oldState) {
    if (!oldState.guild) return;
    const player = this.kazagumo.players.get(oldState.guild.id);
    if (!player) return;
    const voiceChannel = oldState.guild.channels.cache.get(player.voiceId);
    if (voiceChannel && voiceChannel.members.filter(m => !m.user.bot).size === 0) {
      player.destroy();
      this.deleteOldNowPlaying(player);
      this.sessionPlayedTracks.delete(oldState.guild.id);
    };
  };

  handleGuildDelete(guild) {
    const player = this.kazagumo.players.get(guild.id);
    if (player) player.destroy();
    const oldMsg = this.nowPlayingMessages.get(guild.id);
    if (oldMsg) {
      oldMsg.delete().catch(() => {});
      this.nowPlayingMessages.delete(guild.id);
    };
    this.sessionPlayedTracks.delete(guild.id);
  };

  handleChannelDelete(channel) {
    if (channel.type === "GUILD_VOICE") {
      const player = this.kazagumo.players.get(channel.guild.id);
      if (player && player.voiceId === channel.id) {
        player.destroy();
        this.deleteOldNowPlaying(player);
        this.sessionPlayedTracks.delete(channel.guild.id);
      };
    };
  };

  async handlePlayerStart(player, track) {
    this.isSkipping = false;
    const guildId = player.guildId;
    this.lastPlayedTracks.set(guildId, track);
    const sessionPlayed = this.sessionPlayedTracks.get(guildId) || [];
    sessionPlayed.push(track.uri);
    this.sessionPlayedTracks.set(guildId, sessionPlayed);
    if (player.voice) await player.voice.setSelfDeaf(true);
    await this.sendNowPlayingEmbed(player);
    await this.preloadNextTrack(player);
  };

  async handlePlayerEnd(player) {
    await this.deleteOldNowPlaying(player);
    const guildId = player.guildId;
    const isAutoplayEnabled = this.autoplayStates.get(guildId) || false;
    if (isAutoplayEnabled && player.queue.length === 0) {
      await this.addRelatedTrack(player);
      if (player.queue.current && !player.playing) {
        try {
          await player.play();
          if (player.voice) await player.voice.setSelfDeaf(true);
          await this.sendNowPlayingEmbed(player);
        } catch (err) {
          return;
        };
      };
    } else if (player.queue.length > 0 && !player.playing) {
      try {
        await player.play();
        if (player.voice) await player.voice.setSelfDeaf(true);
        await this.sendNowPlayingEmbed(player);
      } catch (err) {
        return;
      };
    };
  };
};

class InteractionHandler {
  constructor(quickMusic) {
    this.quickMusic = quickMusic;
    this.commandAliases = {
      play: ["p"],
      ping: ["latency"],
      help: ["h", "?"],
    };
  };

  async handleMessage(message) {
    const prefixRegex = new RegExp(`^(?:${this.quickMusic.config.prefix}|<@!?${this.quickMusic.client.user.id}>)(?:\\s+)?`);
    if (!prefixRegex.test(message.content) || message.author.bot) return;

    const matchedPrefix = message.content.match(prefixRegex)[0];
    const commandContent = message.content.slice(matchedPrefix.length).trim();
    if (!commandContent) return;

    const args = commandContent.split(/\s+/);
    const command = args.shift()?.toLowerCase();

    const resolvedCommand = Object.keys(this.commandAliases).find(cmd => 
      cmd === command || this.commandAliases[cmd].includes(command)
    );
    if (!resolvedCommand) return;

    if (resolvedCommand === "play") {
      await this.handlePlayCommand(message, args.join(" "));
    } else if (resolvedCommand === "ping") {
      await this.handlePingCommand(message);
    } else if (resolvedCommand === "help") {
      await this.handleHelpCommand(message);
    };
  };

  async handleButton(interaction) {
    const player = this.quickMusic.kazagumo.players.get(interaction.guild.id);
    if (!player) {
      return interaction.reply({ embeds: [this.quickMusic.createEmbed("Error", "No active player.")], flags: 64 });
    };
    if (!interaction.member.voice.channel || interaction.member.voice.channel.id !== player.voiceId) {
      return interaction.reply({ embeds: [this.quickMusic.createEmbed("Error", "You must be in the same voice channel.")], flags: 64 });
    };

    if (interaction.customId === "lyrics") {
      return this.handleLyricsButton(interaction, player);
    };

    await interaction.deferReply({ flags: 64 });
    let embedTitle = "";
    let embedDesc = "";
    switch (interaction.customId) {
      case "pause":
        ({ embedTitle, embedDesc } = await this.handlePauseButton(player, interaction));
        break;
      case "skip":
        ({ embedTitle, embedDesc } = await this.handleSkipButton(player, interaction));
        break;
      case "stop":
        player.destroy();
        embedTitle = "Stopped";
        embedDesc = "Stopped the music and left the voice channel.";
        await this.quickMusic.deleteOldNowPlaying(player);
        this.quickMusic.sessionPlayedTracks.delete(interaction.guild.id);
        break;
      case "loop":
        player.setLoop(player.loop === "none" ? "track" : "none");
        embedTitle = player.loop === "track" ? "Loop Enabled" : "Loop Disabled";
        embedDesc = player.loop === "track" ? "Track will loop continuously." : "Looping is now disabled.";
        break;
      case "queue":
        const queueList = player.queue.slice(0, 20);
        embedTitle = "First 20 Songs in Queue";
        embedDesc = queueList.length ? queueList.map((t, i) => `${i + 1}. ${t.title}`).join("\n") : "No songs in queue.";
        break;
      case "vol_up":
        if (player.volume >= 100) {
          embedTitle = "Volume Error";
          embedDesc = "Cannot increase volume beyond 100%.";
        } else {
          const newVolume = Math.min(player.volume + 10, 100);
          await player.setVolume(newVolume);
          embedTitle = "Volume Updated";
          embedDesc = `Volume increased to ${newVolume}%.`;
        };
        break;
      case "vol_down":
        if (player.volume <= 0) {
          embedTitle = "Volume Error";
          embedDesc = "Volume is already at 0%.";
        } else {
          const newVolume = Math.max(player.volume - 10, 0);
          await player.setVolume(newVolume);
          embedTitle = "Volume Updated";
          embedDesc = `Volume decreased to ${newVolume}%.`;
        };
        break;
      case "autoplay":
        const isAutoplayEnabled = !this.quickMusic.autoplayStates.get(interaction.guild.id);
        this.quickMusic.autoplayStates.set(interaction.guild.id, isAutoplayEnabled);
        embedTitle = isAutoplayEnabled ? "Autoplay Enabled" : "Autoplay Disabled";
        embedDesc = isAutoplayEnabled ? "Autoplay is now enabled." : "Autoplay is now disabled.";
        const nowMsg = this.quickMusic.nowPlayingMessages.get(interaction.guild.id);
        if (nowMsg) {
          try {
            await nowMsg.edit({ components: this.quickMusic.getControlButtons(player.paused, isAutoplayEnabled) });
          } catch (err) {
            return;
          };
        };
        if (isAutoplayEnabled && player.queue.current && player.queue.length <= 1) {
          await this.quickMusic.addRelatedTrack(player);
          if (player.queue.length > 1 && !player.playing) {
            try {
              await player.skip();
              await this.quickMusic.sendNowPlayingEmbed(player);
            } catch (err) {
              return;
            };
          };
        };
        break;
    };
    await interaction.editReply({ embeds: [this.quickMusic.createEmbed(embedTitle, embedDesc)] });
  };

  async handlePlayCommand(message, query) {
    if (!message.member.voice.channel) {
      return message.reply({ embeds: [this.quickMusic.createEmbed("Error", "You must be in a voice channel.")] });
    };
    try {
      let player = this.quickMusic.kazagumo.players.get(message.guild.id);
      if (!player || player.destroyed) {
        player = await this.quickMusic.kazagumo.createPlayer({
          guildId: message.guild.id,
          textId: message.channel.id,
          voiceId: message.member.voice.channel.id,
          volume: 100,
          quality: "very_high",
          bitrate: "510000",
          sampleRate: "96000",
          crossfade: 10,
          leaveOnEnd: false,
          leaveOnStop: true,
          leaveOnEmpty: 300000,
          bufferSize: 32000,
          repositionTracks: true,
          autoPlay: true,
        });
        await player.setVoiceChannel(message.member.voice.channel.id, { selfDeaf: true });
        this.quickMusic.autoplayStates.set(message.guild.id, false);
        this.quickMusic.sessionPlayedTracks.set(message.guild.id, []);
      };
      if (!player.connected) {
        try {
          await player.connect();
          await new Promise(resolve => setTimeout(resolve, 500));
          if (player.voice) await player.voice.setSelfDeaf(true);
        } catch (error) {
          if (error.code !== 1) throw error;
        };
      };
      if (!query) {
        return message.reply({ embeds: [this.quickMusic.createEmbed("Error", "Please provide a song name or URL.")] });
      };
      let searchEngine = "youtube_music";
      if (query.includes("spotify.com") || query.includes("spotify:")) {
        searchEngine = "spotify";
      } else if (query.includes("soundcloud.com")) {
        searchEngine = "soundcloud";
      };
      const search = await this.quickMusic.kazagumo.search(query, { requester: message.author, searchEngine });
      const tracks = search.tracks;
      if (!tracks.length) {
        return message.reply({ embeds: [this.quickMusic.createEmbed("No Results", "No results found.")] });
      };
      if (query.includes("playlist") || query.includes("spotify.com") || query.includes("youtube.com/playlist")) {
        const currentQueueLength = player.queue.length;
        const availableSlots = 100 - currentQueueLength;
        let selectedTracks = tracks;
        let warningMessage = "";
        if (availableSlots <= 0) {
          return message.reply({
            embeds: [this.quickMusic.createEmbed("Playlist Added", "Added 0 song(s) from playlist. Warning: Queue is already full (100 tracks).")],
          });
        };
        if (selectedTracks.length > availableSlots) {
          selectedTracks = selectedTracks.slice(0, availableSlots);
          warningMessage = " Warning: Queue is now full; excess tracks were trimmed.";
        };
        for (const track of selectedTracks) {
          track.requester = message.author;
          player.queue.add(track);
        };
        await message.reply({
          embeds: [this.quickMusic.createEmbed("Playlist Added", `Added ${selectedTracks.length} song(s) from playlist.${warningMessage}`)],
        });
      } else {
        const track = tracks[0];
        track.requester = message.author;
        if (player.queue.some(t => t.uri === track.uri)) {
          return message.reply({ embeds: [this.quickMusic.createEmbed("Duplicate", "This track is already in the queue.")] });
        };
        player.queue.add(track);
        this.quickMusic.lastPlayedTracks.set(message.guild.id, track);
        await message.reply({ embeds: [this.quickMusic.createEmbed("Track Queued", `${track.title}`)] });
      };
      if (!player.playing && player.queue.current) {
        await this.quickMusic.deleteOldNowPlaying(player);
        try {
          await player.play();
          if (player.voice) await player.voice.setSelfDeaf(true);
        } catch (err) {
          throw err;
        };
      };
    } catch (err) {
      console.error("Error in play command:", err);
      if (err.message.includes("Missing Permissions")) {
        return message.reply({ embeds: [this.quickMusic.createEmbed("Error", "I lack permission to join your voice channel.")] });
      };
      return message.reply({ embeds: [this.quickMusic.createEmbed("Error", "An error occurred while processing your request.")] });
    };
  };

  async handleLyricsButton(interaction, player) {
    await interaction.deferReply({ flags: 64 });
    const track = player.queue.current;
    if (!track) {
      return interaction.editReply({ embeds: [this.quickMusic.createEmbed("Error", "No active player.")] });
    };
    await interaction.editReply({ embeds: [this.quickMusic.createEmbed("Fetching Lyrics", "Please wait...")] });
    try {
      let title = track.title;
      let artist = track.author || "";
      if (title.includes(" - ") && !artist) {
        const parts = title.split(" - ");
        artist = parts[0].trim();
        title = parts[1].trim();
      };
      const lyrics = await this.quickMusic.fetchLyrics(title, artist);
      if (lyrics) {
        if (lyrics.length > 4000) {
          const firstPart = lyrics.substring(0, 4000);
          await interaction.editReply({
            embeds: [this.quickMusic.createEmbed(`Lyrics for ${track.title}`, firstPart + "\n\n(Lyrics truncated due to length)")],
          });
        } else {
          await interaction.editReply({ embeds: [this.quickMusic.createEmbed(`Lyrics for ${track.title}`, lyrics)] });
        };
      } else {
        await interaction.editReply({
          embeds: [this.quickMusic.createEmbed("No Lyrics Found", `Couldn't find lyrics for "${track.title}".`)],
        });
      };
    } catch (error) {
      return;
    };
  };

  async handlePingCommand(message) {
    const startTime = Date.now();
    const initialMsg = await message.reply({ embeds: [this.quickMusic.createEmbed("Pinging...", "Calculating...")] });

    try {
      const wsLatency = this.quickMusic.client.ws.ping;
      const messageLatency = Date.now() - startTime;
      const uptimeMs = this.quickMusic.client.uptime;
      const uptimeSeconds = Math.floor(uptimeMs / 1000);
      const days = Math.floor(uptimeSeconds / (24 * 3600));
      const hours = Math.floor((uptimeSeconds % (24 * 3600)) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;
      const uptimeStr = `${days}d ${hours}h ${minutes}m ${seconds}s`;

      await initialMsg.edit({
        embeds: [this.quickMusic.createEmbed("Pong!",
          `• Websocket Latency: **${wsLatency}ms**\n` +
          `• Message Latency: **${messageLatency}ms**\n` +
          `• Uptime: **${uptimeStr}**`
        )],
      });
    } catch (err) {
      return;
    };
  };

  async handleHelpCommand(message) {
    const embed = this.quickMusic.createEmbed(
      "QuickMusic | v1.2",
      "Hello, Thank you for using QuickMusic.\n" +
      "To play a song join a voice channel and use\n" +
      `\`${this.quickMusic.config.prefix}play <song name or URL>\`\n\n` +
      "Once you play a song, you will see the rest of the commands/controls through buttons.\n\n" +
      "**Please Note:**\n" +
      "Currently Spotify/YouTube/Soundcloud links are supported in the play command.\n\n" +
      "**About QuickMusic**\n" +
      "QuickMusic is an open source Discord music bot project made by `@sakshamyep`. " +
      "To view the source code, features, and license, click the button below."
    );

    const sourceCodeButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Source Code")
        .setStyle(ButtonStyle.Link)
        .setURL("https://github.com/sakshamyep/QuickMusic")
    );

    await message.reply({
      embeds: [embed],
      components: [sourceCodeButton],
    });
  };

  async handlePauseButton(player, interaction) {
    player.pause(!player.paused);
    const embedTitle = player.paused ? "Paused" : "Resumed";
    const embedDesc = player.paused ? "Paused the music." : "Resumed the music.";
    const isAutoplayEnabled = this.quickMusic.autoplayStates.get(interaction.guild.id) || false;
    const nowMsg = this.quickMusic.nowPlayingMessages.get(interaction.guild.id);
    if (nowMsg) {
      try {
        await nowMsg.edit({ components: this.quickMusic.getControlButtons(player.paused, isAutoplayEnabled) });
      } catch (err) {
        return;
      };
    };
    return { embedTitle, embedDesc };
  };

  async handleSkipButton(player, interaction) {
    if (!this.quickMusic.isSkipping) {
      this.quickMusic.isSkipping = true;
      await this.quickMusic.deleteOldNowPlaying(player);
      player.skip();
      const guildId = interaction.guild.id;
      const isAutoplayEnabled = this.quickMusic.autoplayStates.get(guildId) || false;
      if (isAutoplayEnabled && player.queue.length === 0) {
        await this.quickMusic.addRelatedTrack(player);
        if (player.queue.current && !player.playing) {
          try {
            await player.play();
            if (player.voice) await player.voice.setSelfDeaf(true);
          } catch (err) {
            return;
          };
        };
      };
      if (!player.playing && player.queue.current) {
        try {
          await player.play();
          if (player.voice) await player.voice.setSelfDeaf(true);
        } catch (err) {
          return;
        };
      };
      this.quickMusic.isSkipping = false;
      return { embedTitle: "Skipped", embedDesc: "Skipped the track." };
    };
    return { embedTitle: "Skip In Progress", embedDesc: "Already skipping a track." };
  };
};

const quickMusic = new QuickMusic();
const interactionHandler = new InteractionHandler(quickMusic);

quickMusic.kazagumo.shoukaku.on("ready", name => console.log(`✅ Node Connected: ${name}`));
quickMusic.kazagumo.shoukaku.on("disconnect", (name, reason) => {
  console.warn(`❌ Node Disconnected: ${name}, Reason: ${reason?.reason || "unknown"}`);
  setTimeout(async () => {
    try {
      await quickMusic.kazagumo.shoukaku.connect(quickMusic.config.lavalink);
      console.log(`✅ Reconnected to Node: ${name}`);
    } catch (err) {
      console.error(`⚠️ Reconnection Failed: ${name}`, err);
    }
  }, 5000);
});
quickMusic.kazagumo.shoukaku.on("error", (name, error) => console.error(`⚠️ Node Error [${name}]:`, error));
quickMusic.kazagumo.on("playerStart", (player, track) => quickMusic.handlePlayerStart(player, track));
quickMusic.kazagumo.on("playerEnd", player => quickMusic.handlePlayerEnd(player));
quickMusic.kazagumo.on("playerException", async (player, error) => {
  console.error(`Player Exception [Guild: ${player.guildId}]:`, error);
  if (!player.connected) {
    await player.connect();
    if (player.queue.current) await player.play();
  }
});

quickMusic.client.once("ready", async () => {
  if (quickMusic.config.botActivity.message) {
    quickMusic.client.user.setActivity({
      name: quickMusic.config.botActivity.message,
      type: quickMusic.getActivityTypeWrapper(quickMusic.config.botActivity.type),
    });
  };
});

quickMusic.client.on("voiceStateUpdate", oldState => quickMusic.handleVoiceStateUpdate(oldState));
quickMusic.client.on("guildDelete", guild => quickMusic.handleGuildDelete(guild));
quickMusic.client.on("channelDelete", channel => quickMusic.handleChannelDelete(channel));
quickMusic.client.on("messageCreate", message => interactionHandler.handleMessage(message));
quickMusic.client.on("interactionCreate", interaction => { if (interaction.isButton()) interactionHandler.handleButton(interaction);
});

process.on("unhandledRejection", error => console.error("Unhandled Rejection:", error));
process.on("uncaughtException", error => console.error("Uncaught Exception:", error));
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  for (const [guildId, player] of quickMusic.kazagumo.players) {
    player.destroy();
  }
  await quickMusic.client.destroy();
  process.exit(0);
});

async function startBot() {
  try {
    await quickMusic.client.login(quickMusic.config.token);
    console.log("✅ Logged in successfully.");
  } catch (error) {
    console.error("❌ Failed to log in:", error);
    process.exit(1);
  };
};
startBot();
/**
 * QuickMusic | v1.2
 * Copyright (c) 2025 Saksham Pandey
 */