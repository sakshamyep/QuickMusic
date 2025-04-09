/**
 * QuickMusic | v1.1
 * Copyright (c) 2025 Saksham Pandey
 **/
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType
} from "discord.js";
import { Kazagumo } from "kazagumo";
import { Connectors } from "shoukaku";
import axios from "axios";

const config = {
  token: process.env.TOKEN,
  prefix: process.env.BOT_PREFIX,
  lavalink: {
    name: process.env.LAVALINK_NAME,
    url: process.env.LAVALINK_URL,
    auth: process.env.LAVALINK_AUTH,
    secure: process.env.LAVALINK_SECURE === "true"
  },
  botActivity: {
    type: process.env.BOT_ACTIVITY_TYPE || "LISTENING",
    message: process.env.BOT_ACTIVITY_MESSAGE || `${process.env.BOT_PREFIX}play`
}};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  allowedMentions: { repliedUser: false },
  cache: {
    messages: false,
    channels: false,
    guilds: false,
    users: false,
}});

const kazagumo = new Kazagumo(
  {
    defaultSearchEngine: "youtube_music",
    send: (guildId, payload) => {
      const guild = client.guilds.cache.get(guildId);
      if (guild) guild.shard.send(payload);
    },
    options: {
      bufferTimeout: 500,
      maxRetries: 3,
      retryDelay: 1000
    }
  },
  new Connectors.DiscordJS(client),
  [{
    ...config.lavalink,
    retryCount: 5,
    retryDelay: 2000
  }]
);

const nowPlayingMessages = new Map();
let isProcessingTrack = false;
let isSkipping = false;
const autoplayStates = new Map();

function getActivityTypeWrapper(type) {
  const types = {
    PLAYING: ActivityType.Playing,
    LISTENING: ActivityType.Listening,
    WATCHING: ActivityType.Watching,
    COMPETING: ActivityType.Competing
  };
  return types[type.toUpperCase()] || ActivityType.Listening;
}

function createEmbed(title, description) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor("#FFFFFF");
}

function getControlButtons(isPaused = false, isAutoplayEnabled = false) {
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
}

class VoiceStateUpdateHandler {
  constructor(client, kazagumo) {
    this.client = client;
    this.kazagumo = kazagumo;
  }

  handle(oldState) {
    if (!oldState.guild) return;
    const player = this.kazagumo.players.get(oldState.guild.id);
    if (!player) return;
    const voiceChannel = oldState.guild.channels.cache.get(player.voiceId);
    if (voiceChannel && voiceChannel.members.filter((m) => !m.user.bot).size === 0) {
      player.destroy();
      deleteOldNowPlaying(player);
    }
  }
}

class GuildDeleteHandler {
  constructor(client, kazagumo, nowPlayingMessages) {
    this.client = client;
    this.kazagumo = kazagumo;
    this.nowPlayingMessages = nowPlayingMessages;
  }

  handle(guild) {
    const player = this.kazagumo.players.get(guild.id);
    if (player) player.destroy();
    const oldMsg = this.nowPlayingMessages.get(guild.id);
    if (oldMsg) {
      oldMsg.delete().catch(() => {});
      this.nowPlayingMessages.delete(guild.id);
    }
  }
}

class channelDelete {
  constructor(client, kazagumo, nowPlayingMessages) {
    this.client = client;
    this.kazagumo = kazagumo;
    this.nowPlayingMessages = nowPlayingMessages;
  }

  handle(channel) {
    if (channel.type === "GUILD_VOICE") {
      const player = this.kazagumo.players.get(channel.guild.id);
      if (player && player.voiceId === channel.id) {
        player.destroy();
        deleteOldNowPlaying(player);
      }
    }
  }
}

class playerStart {
  constructor(client, kazagumo, nowPlayingMessages) {
    this.client = client;
    this.kazagumo = kazagumo;
    this.nowPlayingMessages = nowPlayingMessages;
  }

  async handle(player, track) {
    isSkipping = false;
    player.lastTrack = track;
    if (player.voice) await player.voice.setSelfDeaf(true);
    await sendNowPlayingEmbed(player);
    await preloadNextTrack(player);
  }
}

class playerEnd {
  constructor(client, kazagumo, nowPlayingMessages) {
    this.client = client;
    this.kazagumo = kazagumo;
    this.nowPlayingMessages = nowPlayingMessages;
  }

  async handle(player) {
    await deleteOldNowPlaying(player);
    const isAutoplayEnabled = autoplayStates.get(player.guildId) || false;
    if (isAutoplayEnabled && player.queue.length === 0) {
      await addRelatedTrack(player);
      if (player.queue.current && !player.playing) {
        try {
          await player.play();
          if (player.voice) await player.voice.setSelfDeaf(true);
          await sendNowPlayingEmbed(player);
        } catch (err) {
          return;
        }
      }
    } else if (player.queue.length > 0 && !player.playing) {
      try {
        await player.play();
        if (player.voice) await player.voice.setSelfDeaf(true);
        await sendNowPlayingEmbed(player);
      } catch (err) {
        return;
      }
    }
  }
}

async function deleteOldNowPlaying(player) {
  const oldMsg = nowPlayingMessages.get(player.guildId);
  if (oldMsg) {
    try {
      await oldMsg.delete();
    } catch (err) {
      return;
    }
    nowPlayingMessages.delete(player.guildId);
  }
}

async function sendNowPlayingEmbed(player) {
  if (isProcessingTrack) return;
  isProcessingTrack = true;
  try {
    const channel = client.channels.cache.get(player.textId);
    if (!channel || !player.queue.current) return;
    await deleteOldNowPlaying(player);
    const isAutoplayEnabled = autoplayStates.get(player.guildId) || false;
    const embed = createEmbed(
      "Now Playing",
      `[${player.queue.current.title}](${player.queue.current.uri}) - <@${player.queue.current.requester?.id || client.user.id}>`
    );
    const msg = await channel.send({
      embeds: [embed],
      components: getControlButtons(player.paused, isAutoplayEnabled)
    });
    nowPlayingMessages.set(player.guildId, msg);
  } catch (err) {
    return;
  } finally {
    isProcessingTrack = false;
  }
}

async function fetchLyrics(title, artist) {
  try {
    let cleanTitle = title.replace(/\([^)]*\)|\[[^\]]*\]/g, "").trim();
    cleanTitle = cleanTitle.replace(/feat\.|ft\./i, "").trim();
    const response = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist || "")}/${encodeURIComponent(cleanTitle)}`);
    if (response.data && response.data.lyrics) {
      let lyrics = response.data.lyrics;
      if (lyrics.length > 4000) {
        lyrics = lyrics.substring(0, 4000) + "...\n\n(Lyrics truncated due to length)";
      }
      return lyrics;
    }
    throw new Error("No lyrics found.");
  } catch (error) {
    try {
      const geniusResponse = await axios.get(`https://some-lyrics-api.com/search?q=${encodeURIComponent(title)}`);
      if (geniusResponse.data && geniusResponse.data.lyrics) {
        return geniusResponse.data.lyrics;
      }
    } catch (err) {
      return null;
    }
    return null;
  }
}

async function addRelatedTrack(player) {
  const lastTrack = player.lastTrack || player.queue.current;
  if (!lastTrack) return;

  const primaryArtist = lastTrack.author ? lastTrack.author.split(",")[0].trim() : "";
  let query = primaryArtist ? `${primaryArtist} similar songs` : `${lastTrack.title} similar songs`;
  query += " -live -remix";
  let relatedTracks = await kazagumo.search(query, { searchEngine: "youtube_music" });

  if (!relatedTracks.tracks.length) {
    query = `${lastTrack.title.split("(")[0].trim()} related songs`;
    relatedTracks = await kazagumo.search(query, { searchEngine: "youtube_music" });
  }

  if (relatedTracks.tracks.length > 0) {
    const currentUri = lastTrack.uri;
    const currentDuration = lastTrack.length || 0;
    const filteredTracks = relatedTracks.tracks
      .filter(track => track.uri !== currentUri && Math.abs((track.length || 0) - currentDuration) < 90000)
      .slice(0, 10);

    const tracksToUse = filteredTracks.length ? filteredTracks : relatedTracks.tracks.filter(track => track.uri !== currentUri);
    if (!tracksToUse.length) return;
    const track = tracksToUse[Math.floor(Math.random() * tracksToUse.length)];
    track.requester = client.user;
    player.queue.add(track);
    if (!player.playing && player.queue.length === 1) {
      try {
        await player.play();
      } catch (err) {
        return;
      }
    }
  }
}

async function preloadNextTrack(player) {
  if (player.queue.length > 0 && !player.queue[0].isPreloaded) {
    try {
      const nextTrack = player.queue[0];
      await kazagumo.shoukaku.getNode().decode(nextTrack.uri);
      nextTrack.isPreloaded = true;
    } catch (err) {
      return;
    }
  }
}

class InteractionHandler {
  constructor(client, kazagumo, nowPlayingMessages) {
    this.client = client;
    this.kazagumo = kazagumo;
    this.nowPlayingMessages = nowPlayingMessages;
  }

  async handleMessage(message) {
    const prefixRegex = new RegExp(`^(?:${config.prefix}|<@!?${this.client.user.id}>)(?:\\s+)?`);
    if (!prefixRegex.test(message.content) || message.author.bot) return;

    const matchedPrefix = message.content.match(prefixRegex)[0];
    const commandContent = message.content.slice(matchedPrefix.length).trim();
    if (!commandContent) return;

    const args = commandContent.split(/\s+/);
    const command = args.shift()?.toLowerCase();

    if (!command) return;

    if (command === "play") {
      await this.handlePlayCommand(message, args.join(" "));
    } else if (command === "ping") {
      await this.handlePingCommand(message);
    }
  }

  async handleButton(interaction) {
    const player = this.kazagumo.players.get(interaction.guild.id);
    if (!player) {
      return interaction.reply({ embeds: [createEmbed("Error", "No active player.")], ephemeral: true });
    }
    if (!interaction.member.voice.channel || interaction.member.voice.channel.id !== player.voiceId) {
      return interaction.reply({ embeds: [createEmbed("Error", "You must be in the same voice channel.")], ephemeral: true });
    }

    if (interaction.customId === "lyrics") {
      return this.handleLyricsButton(interaction, player);
    }

    await interaction.deferReply({ ephemeral: true });
    let embedTitle = "";
    let embedDesc = "";
    switch (interaction.customId) {
      case "pause":
        ({ embedTitle, embedDesc } = await handlePauseButton(player, interaction));
        break;
      case "skip":
        ({ embedTitle, embedDesc } = await handleSkipButton(player, interaction));
        break;
      case "stop":
        player.destroy();
        embedTitle = "Stopped";
        embedDesc = "Stopped the music and left the voice channel.";
        await deleteOldNowPlaying(player);
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
        }
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
        }
        break;
      case "autoplay":
        const isAutoplayEnabled = !autoplayStates.get(interaction.guild.id);
        autoplayStates.set(interaction.guild.id, isAutoplayEnabled);
        embedTitle = isAutoplayEnabled ? "Autoplay Enabled" : "Autoplay Disabled";
        embedDesc = isAutoplayEnabled ? "Autoplay is now enabled." : "Autoplay is now disabled.";
        const nowMsg = nowPlayingMessages.get(interaction.guild.id);
        if (nowMsg) {
          try {
            await nowMsg.edit({ components: getControlButtons(player.paused, isAutoplayEnabled) });
          } catch (err) {
            return;
          }
        }
        if (isAutoplayEnabled && player.queue.current && player.queue.length <= 1) {
          player.lastTrack = player.queue.current;
          await addRelatedTrack(player);
          if (player.queue.length > 1 && !player.playing) {
            try {
              await player.skip();
              await sendNowPlayingEmbed(player);
            } catch (err) {
              return;
            }
          }
        }
        break;
    }
    await interaction.editReply({ embeds: [createEmbed(embedTitle, embedDesc)] });
  }

  async handlePlayCommand(message, query) {
    if (!message.member.voice.channel) {
      return message.reply({ embeds: [createEmbed("Error", "You must be in a voice channel.")] });
    }
    try {
      let player = this.kazagumo.players.get(message.guild.id);
      if (!player || player.destroyed) {
        player = await this.kazagumo.createPlayer({
          guildId: message.guild.id,
          textId: message.channel.id,
          voiceId: message.member.voice.channel.id,
          volume: 100,
          quality: "very_high",
          bitrate: "384000",
          sampleRate: "48000",
          crossfade: 10,
          leaveOnEnd: false,
          leaveOnStop: true,
          leaveOnEmpty: 300000,
          bufferSize: 15000,
          repositionTracks: true,
          autoPlay: true
        });
        await player.setVoiceChannel(message.member.voice.channel.id, { selfDeaf: true });
        autoplayStates.set(message.guild.id, false);
      }
      if (!player.connected) {
        try {
          await player.connect();
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (player.voice) await player.voice.setSelfDeaf(true);
        } catch (error) {
          if (error.code !== 1) throw error;
        }
      }
      if (!query) {
        return message.reply({ embeds: [createEmbed("Error", "Please provide a song name or URL.")] });
      }
      let searchEngine = "youtube_music";
      if (query.includes("spotify.com") || query.includes("spotify:")) {
        searchEngine = "spotify";
      }
      const search = await kazagumo.search(query, { requester: message.author, searchEngine });
      const tracks = search.tracks;
      if (!tracks.length) {
        return message.reply({ embeds: [createEmbed("No Results", "No results found.")] });
      }
      if (query.includes("playlist") || query.includes("spotify.com") || query.includes("youtube.com/playlist")) {
        const currentQueueLength = player.queue.length;
        const availableSlots = 100 - currentQueueLength;
        let selectedTracks = tracks;
        let warningMessage = "";
        if (availableSlots <= 0) {
          return message.reply({
            embeds: [createEmbed("Playlist Added", "Added 0 song(s) from playlist. Warning: Queue is already full (100 tracks).")]
          });
        }
        if (selectedTracks.length > availableSlots) {
          selectedTracks = selectedTracks.slice(0, availableSlots);
          warningMessage = " Warning: Queue is now full; excess tracks were trimmed.";
        }
        for (const track of selectedTracks) {
          track.requester = message.author;
          player.queue.add(track);
        }
        await message.reply({
          embeds: [createEmbed("Playlist Added", `Added ${selectedTracks.length} song(s) from playlist.${warningMessage}`)]
        });
      } else {
        const track = tracks[0];
        track.requester = message.author;
        player.queue.add(track);
        await message.reply({ embeds: [createEmbed("Track Queued", `${track.title}`)] });
      }
      if (!player.playing && player.queue.current) {
        await deleteOldNowPlaying(player);
        try {
          await player.play();
          if (player.voice) await player.voice.setSelfDeaf(true);
        } catch (err) {
          throw err;
        }
      }
    } catch (err) {
      console.error("Error in play command:", err);
      if (err.message.includes("Missing Permissions")) {
        return message.reply({ embeds: [createEmbed("Error", "I lack permission to join your voice channel.")] });
      }
      return message.reply({ embeds: [createEmbed("Error", "An error occurred while processing your request.")] });
    }
  }

  async handleLyricsButton(interaction, player) {
    await interaction.deferReply({ ephemeral: true });
    const track = player.queue.current;
    if (!track) {
      return interaction.editReply({ embeds: [createEmbed("Error", "No active player.")] });
    }
    await interaction.editReply({ embeds: [createEmbed("Fetching Lyrics", "Please wait...")] });
    try {
      let title = track.title;
      let artist = track.author || "";
      if (title.includes(" - ") && !artist) {
        const parts = title.split(" - ");
        artist = parts[0].trim();
        title = parts[1].trim();
      }
      const lyrics = await fetchLyrics(title, artist);
      if (lyrics) {
        if (lyrics.length > 4000) {
          const firstPart = lyrics.substring(0, 4000);
          await interaction.editReply({
            embeds: [createEmbed(`Lyrics for ${track.title}`, firstPart + "\n\n(Lyrics truncated due to length)")]
          });
        } else {
          await interaction.editReply({ embeds: [createEmbed(`Lyrics for ${track.title}`, lyrics)] });
        }
      } else {
        await interaction.editReply({
          embeds: [createEmbed("No Lyrics Found", `Couldn't find lyrics for "${track.title}".`)]
        });
      }
    } catch (error) {
      return;
    }
  }

  async handlePingCommand(message) {
    const startTime = Date.now();
    const initialMsg = await message.reply({ embeds: [createEmbed("Pinging...", "Calculating...")] });

    try {
      const wsLatency = client.ws.ping;
      const messageLatency = Date.now() - startTime;
      const player = this.kazagumo.players.get(message.guild.id);

      const uptimeMs = client.uptime;
      const uptimeSeconds = Math.floor(uptimeMs / 1000);
      const days = Math.floor(uptimeSeconds / (24 * 3600));
      const hours = Math.floor((uptimeSeconds % (24 * 3600)) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;
      const uptimeStr = `${days}d ${hours}h ${minutes}m ${seconds}s`;

      await initialMsg.edit({
        embeds: [createEmbed("Pong!",
          `• Websocket Latency: **${wsLatency}ms**\n` +
          `• Message Latency: **${messageLatency}ms**\n` +
          `• Uptime: **${uptimeStr}**`
        )]
      });
    } catch (err) {
      return;
    }
  }
}

async function handlePauseButton(player, interaction) {
    player.pause(!player.paused);
    const embedTitle = player.paused ? "Paused" : "Resumed";
    const embedDesc = player.paused ? "Paused the music." : "Resumed the music.";
    const isAutoplayEnabled = autoplayStates.get(interaction.guild.id) || false;
    const nowMsg = nowPlayingMessages.get(interaction.guild.id);
    if (nowMsg) {
      try {
        await nowMsg.edit({ components: getControlButtons(player.paused, isAutoplayEnabled) });
      } catch (err) {
        return;
      }
    }
    return { embedTitle, embedDesc };
  }
  
  async function handleSkipButton(player, interaction) {
    if (!isSkipping) {
      isSkipping = true;
      await deleteOldNowPlaying(player);
      player.skip();
      const isAutoplayEnabled = autoplayStates.get(interaction.guild.id) || false;
      if (isAutoplayEnabled && player.queue.length === 0) {
        await addRelatedTrack(player);
        if (player.queue.current && !player.playing) {
          try {
            await player.play();
            if (player.voice) await player.voice.setSelfDeaf(true);
          } catch (err) {
            return;
          }
        }
      }
      if (!player.playing && player.queue.current) {
        try {
          await player.play();
          if (player.voice) await player.voice.setSelfDeaf(true);
        } catch (err) {
          return;
        }
      }
      isSkipping = false;
      return { embedTitle: "Skipped", embedDesc: "Skipped the track." };
    }
    return { embedTitle: "Skip In Progress", embedDesc: "Already skipping a track." };
  }
  
  kazagumo.shoukaku.on("ready", (name) => console.log(`✅ Node Connected: ${name}`));
  kazagumo.shoukaku.on("disconnect", (name, reason) => console.warn(`❌ Node Disconnected: ${name}, Reason: ${reason?.reason || "unknown"}`));
  kazagumo.shoukaku.on("error", (name, error) => console.error(`⚠️ Node Error [${name}]:`, error));
  
  kazagumo.on("playerStart", async (player, track) => {
    const playerStartHandler = new playerStart(client, kazagumo, nowPlayingMessages);
    await playerStartHandler.handle(player, track);
  });
  
  kazagumo.on("playerEnd", async (player) => {
    const playerEndHandler = new playerEnd(client, kazagumo, nowPlayingMessages);
    await playerEndHandler.handle(player);
  });
  
  client.once("ready", async () => {
    if (config.botActivity.message) {
      client.user.setActivity({
        name: config.botActivity.message,
        type: getActivityTypeWrapper(config.botActivity.type)
      });
}});
  
  const voiceStateHandler = new VoiceStateUpdateHandler(client, kazagumo);
  client.on("voiceStateUpdate", (oldState) => voiceStateHandler.handle(oldState));
  
  const guildDeleteHandler = new GuildDeleteHandler(client, kazagumo, nowPlayingMessages);
  client.on("guildDelete", (guild) => guildDeleteHandler.handle(guild));
  
  const channelDeleteHandler = new channelDelete(client, kazagumo, nowPlayingMessages);
  client.on("channelDelete", (channel) => channelDeleteHandler.handle(channel));
  
  const interactionHandler = new InteractionHandler(client, kazagumo, nowPlayingMessages);
  client.on("messageCreate", (message) => interactionHandler.handleMessage(message));
  client.on("interactionCreate", (interaction) => {
    if (interaction.isButton()) interactionHandler.handleButton(interaction);
  });
   
  process.on("unhandledRejection", (error) => console.error("Unhandled Rejection:", error));
  process.on("uncaughtException", (error) => console.error("Uncaught Exception:", error));
  
  async function startBot() {
    try {
      await client.login(config.token);
      console.log("✅ Logged in successfully.");
    } catch (error) {
      console.error("❌ Failed to log in:", error);
      process.exit(1);
    }
  }
  startBot();
  /**
   * QuickMusic | v1.1
   * Copyright (c) 2025 Saksham Pandey
   **/
