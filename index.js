/**
 * QuickMusic
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
    }
  },
  new Connectors.DiscordJS(client),
  [config.lavalink]
);

const nowPlayingMessages = new Map();
let isProcessingTrack = false;
let isSkipping = false;

function getActivityTypeWrapper(type) {
  const types = {
    PLAYING: ActivityType.Playing,
    LISTENING: ActivityType.Listening,
    WATCHING: ActivityType.Watching,
    COMPETING: ActivityType.Competing
  };
  return types[type.toUpperCase()] || ActivityType.Listening;
}

kazagumo.shoukaku.on("ready", (name) =>
  console.log(`✅ Lavalink Node Connected: ${name}`)
);
kazagumo.shoukaku.on("disconnect", (name, reason) =>
  console.warn(`❌ Lavalink Node Disconnected: ${name}, Reason: ${reason?.reason || "unknown"}`)
);
kazagumo.shoukaku.on("error", (name, error) =>
  console.error(`⚠️ Lavalink Error [${name}]:`, error)
);

function createEmbed(title, description) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor("#FF0000");
}

function getControlButtons(isPaused = false) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("pause")
      .setLabel(isPaused ? "Resume" : "Pause")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("stop").setLabel("Stop").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("skip").setLabel("Skip").setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("loop").setLabel("Loop").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("queue").setLabel("Queue").setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("vol_down").setLabel("Vol -").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("vol_placeholder")
      .setEmoji("🔇")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder().setCustomId("vol_up").setLabel("Vol +").setStyle(ButtonStyle.Secondary)
  );
  return [row1, row2, row3];
}

async function deleteOldNowPlaying(player) {
  const oldMsg = nowPlayingMessages.get(player.guildId);
  if (oldMsg) {
    try {
      await oldMsg.delete();
    } catch {}
    nowPlayingMessages.delete(player.guildId);
  }
}

async function sendNowPlayingEmbed(player) {
  if (isProcessingTrack) return;
  isProcessingTrack = true;
  try {
    const channel = client.channels.cache.get(player.textId);
    if (!channel) return;
    const currentTrack = player.queue.current;
    if (!currentTrack) return;
    await deleteOldNowPlaying(player);
    const embed = createEmbed("Now Playing", `${currentTrack.title} - <@${currentTrack.requester?.id}>`);
    const msg = await channel.send({
      embeds: [embed],
      components: getControlButtons(player.paused),
      allowedMentions: { parse: [] }
    });
    nowPlayingMessages.set(player.guildId, msg);
  } catch (err) {
    console.error("Error sending Now Playing embed:", err);
  } finally {
    isProcessingTrack = false;
  }
}

const CACHE_TTL = 5 * 60 * 1000;
const trackCache = new Map();

async function getCachedTracks(guildId, query, requester) {
  let searchEngine = "youtube_music";
  if (query.includes("spotify.com") || query.includes("spotify:")) {
    searchEngine = "spotify";
  }
  console.log(`Using search engine: ${searchEngine} for query: ${query}`);
  let guildCache = trackCache.get(guildId) || new Map();
  const cached = guildCache.get(query);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    trackCache.set(guildId, guildCache);
    return cached.tracks;
  }
  if (cached) guildCache.delete(query);
  const search = await kazagumo.search(query, { requester, searchEngine });
  guildCache.set(query, { tracks: search.tracks, timestamp: Date.now() });
  trackCache.set(guildId, guildCache);
  return search.tracks;
}

function clearGuildCache(guildId) {
  if (trackCache.has(guildId)) trackCache.delete(guildId);
}

kazagumo.on("playerStart", async (player, track) => {
  isSkipping = false;
  player.lastTrack = track;
  await sendNowPlayingEmbed(player);
});

kazagumo.on("playerEnd", async (player) => {
  await deleteOldNowPlaying(player);
  if (player.queue.length > 0) {
    if (!player.playing) {
      try {
        player.play();
      } catch (err) {
        console.error("Error auto-playing next track:", err);
      }
    }
  } else {
    clearGuildCache(player.guildId);
  }
});

client.on("voiceStateUpdate", (oldState) => {
  if (!oldState.guild) return;
  const player = kazagumo.players.get(oldState.guild.id);
  if (!player) return;
  const voiceChannel = oldState.guild.channels.cache.get(player.voiceId);
  if (voiceChannel && voiceChannel.members.filter((m) => !m.user.bot).size === 0) {
    player.destroy();
    deleteOldNowPlaying(player);
    clearGuildCache(oldState.guild.id);
  }
});

client.on("guildDelete", (guild) => {
  const player = kazagumo.players.get(guild.id);
  if (player) player.destroy();
  const oldMsg = nowPlayingMessages.get(guild.id);
  if (oldMsg) {
    oldMsg.delete().catch(() => {});
    nowPlayingMessages.delete(guild.id);
  }
  clearGuildCache(guild.id);
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "play") {
    await interaction.deferReply({ flags: 64 });
    if (!interaction.member.voice.channel) {
      return interaction.editReply({
        embeds: [createEmbed("Error", "You must be in a voice channel.")]
      });
    }
    try {
      let player = kazagumo.players.get(interaction.guild.id);
      if (!player || player.destroyed) {
        player = await kazagumo.createPlayer({
          guildId: interaction.guild.id,
          textId: interaction.channel.id,
          voiceId: interaction.member.voice.channel.id,
          volume: 100,
          quality: "high",
          crossfade: 5,
          leaveOnEnd: false,
          leaveOnStop: true,
          leaveOnEmpty: 300000,
          bufferSize: 512,
          repositionTracks: true
        });
        await player.setVoiceChannel(interaction.member.voice.channel.id, { selfDeaf: true });
      }
      if (!player.connected) {
        try {
          await player.connect();
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (player.voice) await player.voice.setSelfDeaf(true);
        } catch (error) {
          if (error.code !== 1) throw error;
        }
      }
      const query = interaction.options.getString("query");
      const tracks = await getCachedTracks(interaction.guild.id, query, interaction.user);
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
                "Added 0 song(s) from playlist. Warning: Queue is already 100, cannot add more songs. Wait till the queue finishes or skip or stop."
              )
            ]
          });
        }
        if (selectedTracks.length > availableSlots) {
          selectedTracks = selectedTracks.slice(0, availableSlots);
          warningMessage = " Warning: Queue is now full, cannot add more songs.";
        }
        for (const track of selectedTracks) {
          track.requester = interaction.user;
          player.queue.add(track);
        }
        await interaction.editReply({
          embeds: [createEmbed("Playlist Added", `Added ${selectedTracks.length} song(s) from playlist.${warningMessage}`)]
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
        } catch (err) {
          console.error("Error starting playback:", err);
        }
      }
    } catch (err) {
      console.error("Error in play command:", err);
      return interaction.editReply({ embeds: [createEmbed("Error", "An error occurred.")] });
    }
  } else if (interaction.isButton()) {
    const player = kazagumo.players.get(interaction.guild.id);
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
        .reply({ embeds: [createEmbed("Error", "You must be in the same voice channel!")], flags: 64 })
        .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 5000));
    }
    await interaction.deferReply({ flags: 64 });
    let embedTitle = "";
    let embedDesc = "";
    switch (interaction.customId) {
      case "pause":
        player.pause(!player.paused);
        embedTitle = player.paused ? "Paused" : "Resumed";
        embedDesc = player.paused ? "Paused the music." : "Resumed the music.";
        {
          const nowMsg = nowPlayingMessages.get(interaction.guild.id);
          if (nowMsg) {
            nowMsg.edit({ components: getControlButtons(player.paused) }).catch(() => {});
          }
        }
        break;
      case "skip":
        if (!isSkipping) {
          isSkipping = true;
          await deleteOldNowPlaying(player);
          player.skip();
          if (!player.playing && player.queue.current) {
            try {
              player.play();
            } catch (err) {
              console.error("Error auto-playing after skip:", err);
            }
          }
          embedTitle = "Skipped";
          embedDesc = "Skipped the track.";
        } else {
          embedTitle = "Skip In Progress";
          embedDesc = "Already skipping a track.";
        }
        break;
      case "stop":
        player.destroy();
        embedTitle = "Stopped";
        embedDesc = "Stopped the music and left the voice channel.";
        await deleteOldNowPlaying(player);
        clearGuildCache(interaction.guild.id);
        break;
      case "loop":
        player.setLoop(player.loop === "none" ? "track" : "none");
        embedTitle = player.loop === "track" ? "Loop Enabled" : "Loop Disabled";
        embedDesc =
          player.loop === "track" ? "Track will loop continuously." : "Looping is now disabled.";
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
          embedDesc = "Cannot increase volume further.";
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
          embedDesc = "Volume is already set to 0%.";
        } else {
          const newVolume = Math.max(player.volume - 10, 0);
          await player.setVolume(newVolume);
          embedTitle = "Volume Updated";
          embedDesc = `Volume decreased to ${newVolume}%.`;
        }
        break;
    }
    await interaction.editReply({ embeds: [createEmbed(embedTitle, embedDesc)] });
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
  console.log(`${client.user.tag} is ready!`);
});

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

client.login(config.token).catch(console.error);
/**
 * QuickMusic
 * Copyright (c) 2025 Saksham Pandey
 **/
