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
  lavalink: {
    name: process.env.LAVALINK_NAME,
    url: process.env.LAVALINK_URL,
    auth: process.env.LAVALINK_AUTH,
    secure: process.env.LAVALINK_SECURE === "true"
  },
  botActivity: {
    type: process.env.BOT_ACTIVITY_TYPE || "LISTENING",
    message: process.env.BOT_ACTIVITY_MESSAGE || "/play"
  }
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

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
    .setColor("#FF0000");
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
    if (!channel) {
      return;
    }
    const currentTrack = player.queue.current;
    if (!currentTrack) {
      return;
    }
    await deleteOldNowPlaying(player);
    const isAutoplayEnabled = autoplayStates.get(player.guildId) || false;
    const embed = createEmbed(
      "Now Playing",
      `[${currentTrack.title}](${currentTrack.uri}) - <@${currentTrack.requester?.id || client.user.id}>`
    );
    const msg = await channel.send({
      embeds: [embed],
      components: getControlButtons(player.paused, isAutoplayEnabled),
      allowedMentions: { parse: [] }
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
    let searchQuery = artist ? `${cleanTitle} ${artist}` : cleanTitle;   
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
      return;
    }  
    return null;
  }
}

async function addRelatedTrack(player) {
  const lastTrack = player.lastTrack || player.queue.current;
  if (!lastTrack) {
    return;
  }
  
  const primaryArtist = lastTrack.author ? lastTrack.author.split(",")[0].trim() : "";
  let query = primaryArtist ? `${primaryArtist} similar songs` : `${lastTrack.title} similar songs`;
  query += " -live -remix"; 
  let relatedTracks = await kazagumo.search(query, { searchEngine: "youtube_music" });

  if (!relatedTracks.tracks.length) {
    console.log(`No results for primary query: ${query}, trying fallback`);
    query = `${lastTrack.title.split("(")[0].trim()} related songs`; 
    relatedTracks = await kazagumo.search(query, { searchEngine: "youtube_music" });
  }

  if (relatedTracks.tracks.length > 0) {
    const currentUri = lastTrack.uri;
    const currentDuration = lastTrack.length || 0;
    const filteredTracks = relatedTracks.tracks
      .filter(track => 
        track.uri !== currentUri &&
        Math.abs((track.length || 0) - currentDuration) < 90000 
      )
      .slice(0, 10); 

    if (filteredTracks.length === 0) {
      const fallbackTracks = relatedTracks.tracks.filter(track => track.uri !== currentUri);
      if (fallbackTracks.length === 0) return;
      const randomIndex = Math.floor(Math.random() * fallbackTracks.length);
      const track = fallbackTracks[randomIndex];
      track.requester = client.user;
      player.queue.add(track);
    } else {
      const randomIndex = Math.floor(Math.random() * filteredTracks.length);
      const track = filteredTracks[randomIndex];
      track.requester = client.user;
      player.queue.add(track);
    }

    if (!player.playing && player.queue.length === 1) {
      try {
        player.play();
      } catch (err) {
        return;
      }
    }
  } else {
    return;
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

class InteractionHandler {
  constructor(client, kazagumo, nowPlayingMessages) {
    this.client = client;
    this.kazagumo = kazagumo;
    this.nowPlayingMessages = nowPlayingMessages;
  }

  async handle(interaction) {
    if (interaction.isChatInputCommand() && interaction.commandName === "play") {
      await this.handlePlayCommand(interaction);
    } else if (interaction.isButton()) {
      await this.handleButtonInteraction(interaction);
    }
  }

  async handlePlayCommand(interaction) {
    await interaction.deferReply({ flags: 64 });
    if (!interaction.member.voice.channel) {
      return interaction.editReply({
        embeds: [createEmbed("Error", "You must be in a voice channel.")]
      });
    }
    try {
      let player = this.kazagumo.players.get(interaction.guild.id);
      if (!player || player.destroyed) {
        player = await this.kazagumo.createPlayer({
          guildId: interaction.guild.id,
          textId: interaction.channel.id,
          voiceId: interaction.member.voice.channel.id,
          volume: 100,
          quality: "very_high",
          crossfade: 5,
          leaveOnEnd: false,
          leaveOnStop: true,
          leaveOnEmpty: 300000,
          bufferSize: 480000,
          repositionTracks: true
        });
        await player.setVoiceChannel(interaction.member.voice.channel.id, { selfDeaf: true });
        autoplayStates.set(interaction.guild.id, true);
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
      const query = interaction.options.getString("query");
      let searchEngine = "youtube_music";
      if (query.includes("spotify.com") || query.includes("spotify:")) {
        searchEngine = "spotify";
      }
      const search = await kazagumo.search(query, { requester: interaction.user, searchEngine });
      const tracks = search.tracks;
      if (!tracks.length) {
        return interaction.editReply({
          embeds: [createEmbed("No Results", "No results found.")]
        });
      }
      if (
        query.includes("playlist") ||
        query.includes("spotify.com") ||
        query.includes("youtube.com/playlist")
      ) {
        const currentQueueLength = player.queue.length;
        const availableSlots = 100 - currentQueueLength;
        let selectedTracks = tracks;
        let warningMessage = "";
        if (availableSlots <= 0) {
          return interaction.editReply({
            embeds: [
              createEmbed(
                "Playlist Added",
                "Added 0 song(s) from playlist. Warning: Queue is already full (100 tracks). Clear or skip to add more."
              )
            ]
          });
        }
        if (selectedTracks.length > availableSlots) {
          selectedTracks = selectedTracks.slice(0, availableSlots);
          warningMessage = " Warning: Queue is now full; excess tracks were trimmed.";
        }
        for (const track of selectedTracks) {
          track.requester = interaction.user;
          player.queue.add(track);
        }
        await interaction.editReply({
          embeds: [
            createEmbed(
              "Playlist Added",
              `Added ${selectedTracks.length} song(s) from playlist.${warningMessage}`
            )
          ]
        });
      } else {
        const track = tracks[0];
        track.requester = interaction.user;
        player.queue.add(track);
        await interaction.editReply({
          embeds: [createEmbed("Track Queued", `${track.title}`)]
        });
      }
      if (!player.playing) {
        await deleteOldNowPlaying(player);
        try {
          player.play();
          if (player.voice) await player.voice.setSelfDeaf(true);
        } catch (err) {
          return;
          throw err;
        }
      }
    } catch (err) {
      console.error("Error in play command:", err);
      if (err.message.includes("Missing Permissions")) {
        return interaction.editReply({
          embeds: [createEmbed("Error", "I lack permission to join your voice channel.")]
        });
      }
      return interaction.editReply({
        embeds: [createEmbed("Error", "An error occurred while processing your request.")]
      });
    }
  }

  async handleButtonInteraction(interaction) {
    const player = this.kazagumo.players.get(interaction.guild.id);
    if (!player) {
      return interaction
        .reply({ embeds: [createEmbed("Error", "No active player.")], flags: 64 })
        .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 5000));
    }
    if (
      !interaction.member.voice.channel ||
      interaction.member.voice.channel.id !== player.voiceId
    ) {
      return interaction
        .reply({
          embeds: [createEmbed("Error", "You must be in the same voice channel.")],
          flags: 64
        })
        .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 5000));
    }
    
    if (interaction.customId === "lyrics") {
      return this.handleLyricsButton(interaction, player);
    }
    
    await interaction.deferReply({ flags: 64 });
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
        embedDesc = player.loop === "track"
          ? "Track will loop continuously."
          : "Looping is now disabled.";
        break;
      case "queue":
        const queueList = player.queue.slice(0, 20);
        embedTitle = "First 20 Songs in Queue";
        embedDesc = queueList.length
          ? queueList.map((t, i) => `${i + 1}. ${t.title}`).join("\n")
          : "No songs in queue.";
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
        embedDesc = isAutoplayEnabled
          ? "Autoplay is now enabled. Related tracks will be added automatically."
          : "Autoplay is now disabled.";
        const nowMsg = nowPlayingMessages.get(interaction.guild.id);
        if (nowMsg) {
          try {
            await nowMsg.edit({
              components: getControlButtons(player.paused, isAutoplayEnabled)
            });
          } catch (err) {
            return;
          }
        }
        break;
    }
    await interaction.editReply({ embeds: [createEmbed(embedTitle, embedDesc)] });
  }
  
  async handleLyricsButton(interaction, player) {
    await interaction.deferReply({ ephemeral: true });
    
    const track = player.queue.current;
    if (!track) {
      return interaction.editReply({
        embeds: [createEmbed("Error", "No active player.")]
      });
    }
    
    await interaction.editReply({
      embeds: [createEmbed("Fetching Lyrics", "Please wait...")]
    });
    
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
            embeds: [createEmbed(`Lyrics for ${track.title}`, 
              firstPart + "\n\n(Lyrics truncated due to length)")]
          });
        } else {
          await interaction.editReply({
            embeds: [createEmbed(`Lyrics for ${track.title}`, lyrics)]
          });
        }
      } else {
        await interaction.editReply({
          embeds: [createEmbed("No Lyrics Found", 
            `Couldn't find lyrics for "${track.title}". This could be due to:\n
            • The song is instrumental.
            • The song is too new or obscure.
            • Lyrics API issues.`)]
        });
      }
    } catch (error) {
      console.error("Error in lyrics command:", error);
      await interaction.editReply({
        embeds: [createEmbed("Error", "An error occurred while fetching lyrics.")]
      });
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
      await nowMsg.edit({
        components: getControlButtons(player.paused, isAutoplayEnabled)
      });
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
        player.play();
        if (player.voice) await player.voice.setSelfDeaf(true);
      }
    }
    if (!player.playing && player.queue.current) {
      try {
        player.play();
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

kazagumo.shoukaku.on("ready", (name) =>
  console.log(`✅ Node Connected: ${name}`)
);
kazagumo.shoukaku.on("disconnect", (name, reason) =>
  console.warn(`❌ Node Disconnected: ${name}, Reason: ${reason?.reason || "unknown"}`)
);
kazagumo.shoukaku.on("error", (name, error) =>
  console.error(`⚠️ Node Error [${name}]:`, error)
);

kazagumo.on("playerStart", async (player, track) => {
  isSkipping = false;
  player.lastTrack = track;
  if (player.voice) await player.voice.setSelfDeaf(true);
  await sendNowPlayingEmbed(player);
  await preloadNextTrack(player);
});

kazagumo.on("playerEnd", async (player) => {
  await deleteOldNowPlaying(player);
  const isAutoplayEnabled = autoplayStates.get(player.guildId) || false;
  if (isAutoplayEnabled && player.queue.length === 0) {
    await addRelatedTrack(player);
    if (player.queue.current && !player.playing) {
      try {
        player.play();
        if (player.voice) await player.voice.setSelfDeaf(true);
        await sendNowPlayingEmbed(player);
      } catch (err) {
        return;
      }
    }
  } else if (player.queue.length > 0) {
    if (!player.playing) {
      try {
        player.play();
        if (player.voice) await player.voice.setSelfDeaf(true);
        await sendNowPlayingEmbed(player);
      } catch (err) {
        return;
      }
    }
  } else if (player.queue.length > 0) {
    if (!player.playing) {
      try {
        player.play();
        if (player.voice) await player.voice.setSelfDeaf(true);
        await sendNowPlayingEmbed(player);
      } catch (err) {
        return;
      }
    }
  } else {
    return;
  }
});

client.once("ready", async () => {
  try {
    await client.application.commands.set([
      {
        name: "play",
        description: "Plays a song from Spotify or YouTube.",
        options: [
          {
            name: "query",
            type: 3,
            description: "Song name or URL",
            required: true
          }
        ]
      }
    ]);
    if (config.botActivity.message) {
      client.user.setActivity({
        name: config.botActivity.message,
        type: getActivityTypeWrapper(config.botActivity.type)
      });
    }
  } catch (error) {
    console.error("Error during startup:", error);
  }
});

const voiceStateHandler = new VoiceStateUpdateHandler(client, kazagumo);
client.on("voiceStateUpdate", (oldState) => voiceStateHandler.handle(oldState));

const guildDeleteHandler = new GuildDeleteHandler(client, kazagumo, nowPlayingMessages);
client.on("guildDelete", (guild) => guildDeleteHandler.handle(guild));

const interactionHandler = new InteractionHandler(client, kazagumo, nowPlayingMessages);
client.on("interactionCreate", (interaction) => interactionHandler.handle(interaction));

client.on("channelDelete", (channel) => {
  if (channel.type === "GUILD_VOICE") {
    const player = kazagumo.players.get(channel.guild.id);
    if (player && player.voiceId === channel.id) {
      player.destroy();
      deleteOldNowPlaying(player);
    }
  }
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