/**
 * QuickMusic | v1.5
 * Copyright (c) 2025 Saksham Pandey
 */
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType
} from 'discord.js';
import { Kazagumo } from 'kazagumo';
import { Connectors } from 'shoukaku';
import axios from 'axios';
import os from 'os';

class QuickMusic {
  constructor() {
    if (
      !process.env.TOKEN ||
      !process.env.BOT_PREFIX ||
      !process.env.LAVALINK_NAME ||
      !process.env.LAVALINK_URL ||
      !process.env.LAVALINK_AUTH ||
      !process.env.SPOTIFY_CLIENT_ID ||
      !process.env.SPOTIFY_CLIENT_SECRET
    ) {
      throw new Error('Missing required environment variables.');
    }

    this.config = {
      token: process.env.TOKEN,
      prefix: process.env.BOT_PREFIX,
      lavalink: {
        name: process.env.LAVALINK_NAME,
        url: process.env.LAVALINK_URL,
        auth: process.env.LAVALINK_AUTH,
        secure: process.env.LAVALINK_SECURE === 'true'
      },
      spotify: {
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET
      }
    };

    this.client = new Client({
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
        users: false
      }
    });

    this.kazagumo = new Kazagumo(
      {
        defaultSearchEngine: 'spotify',
        send: (guildId, payload) => {
          const guild = this.client.guilds.cache.get(guildId);
          if (guild) guild.shard.send(payload);
        },
        spotify: {
          clientId: this.config.spotify.clientId,
          clientSecret: this.config.spotify.clientSecret
        },
        options: {
          bufferTimeout: 800,
          maxRetries: 3,
          retryDelay: 1500
        }
      },
      new Connectors.DiscordJS(this.client),
      [
        {
          ...this.config.lavalink,
          retryCount: 3,
          retryDelay: 1500
        }
      ]
    );

    this.nowPlayingMessages = new Map();
    this.queueMessages = new Map();
    this.isProcessingTrack = false;
    this.isSkipping = false;
    this.autoplayStates = new Map();
    this.lastPlayedTracks = new Map();
    this.sessionPlayedTracks = new Map();
    this.taskQueue = { enqueue: async (task) => await task() };
  }

  createEmbed(title, description) {
    return new EmbedBuilder().setTitle(title).setDescription(description).setColor('#FFFFFF');
  }

  getControlButtons(isPaused = false, isAutoplayEnabled = false) {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('pause')
        .setLabel(isPaused ? 'Resume' : 'Pause')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('skip')
        .setLabel('Skip')
        .setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('loop')
        .setLabel('Loop')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('queue')
        .setLabel('Queue')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('autoplay')
        .setLabel('Autoplay')
        .setStyle(isAutoplayEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
    );
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('vol_down')
        .setLabel('Vol -')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('lyrics')
        .setLabel('Lyrics')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('vol_up')
        .setLabel('Vol +')
        .setStyle(ButtonStyle.Secondary)
    );
    return [row1, row2, row3];
  }

  async deleteOldNowPlaying(playerOrGuild) {
    const guildId = playerOrGuild.guildId || playerOrGuild;
    const oldMsg = this.nowPlayingMessages.get(guildId);

    if (!oldMsg) return;

    try {
      await oldMsg.delete();
    } catch (error) {
      if (error.code === 10008) {
        return null;
      } else {
      	return null;
      }
    } finally {
      this.nowPlayingMessages.delete(guildId);
    }
  }

  async deleteOldQueueMessage(guildId) {
    const oldMsg = this.queueMessages.get(guildId);
    if (oldMsg) {
      try {
        await oldMsg.delete();
      } catch (error) {
        if (error.code !== 10008) {
          return null;
        }
      }
      this.queueMessages.delete(guildId);
    }
  }

  async sendNowPlayingEmbed(player) {
    if (this.isProcessingTrack || player.destroyed) return;
    this.isProcessingTrack = true;
    const channel = this.client.channels.cache.get(player.textId);
    if (!channel || !player.queue.current) {
      this.isProcessingTrack = false;
      return;
    }
    await this.taskQueue.enqueue(async () => {
      await this.deleteOldNowPlaying(player);
      const isAutoplayEnabled = this.autoplayStates.get(player.guildId) ?? false;
      const embed = this.createEmbed(
        'Now Playing',
        `[${player.queue.current.title}](${player.queue.current.uri}) - <@${player.queue.current.requester?.id ?? this.client.user.id}>`
      );
      const msg = await channel.send({
        embeds: [embed],
        components: this.getControlButtons(player.paused, isAutoplayEnabled)
      });
      this.nowPlayingMessages.set(player.guildId, msg);
      this.isProcessingTrack = false;
    });
  }

  async fetchLyrics(title, artist) {
    const fetchWithTimeout = async (url, timeout = 10000) => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await axios.get(url, { signal: controller.signal });
        clearTimeout(id);
        return response;
      } catch (error) {
        clearTimeout(id);
        throw error;
      }
    };
    let cleanTitle = title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
    cleanTitle = cleanTitle.replace(/feat\.|ft\./gi, '').trim();
    try {
      const response = await fetchWithTimeout(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(artist ?? '')}/${encodeURIComponent(cleanTitle)}`
      );
      if (response?.data?.lyrics) {
        let lyrics = response.data.lyrics;
        if (lyrics.length > 4000) {
          lyrics = `${lyrics.substring(0, 4000)}...\n\n(Lyrics truncated due to length)`;
        }
        return lyrics;
      }
    } catch {}
    try {
      const geniusResponse = await fetchWithTimeout(
        `https://some-lyrics-api.com/search?q=${encodeURIComponent(cleanTitle)}`
      );
      return geniusResponse?.data?.lyrics ?? null;
    } catch {
      return null;
    }
  }

  async addRelatedTrack(player) {
    if (player.destroyed || !player.queue) return false;

    const guildId = player.guildId;
    const isAutoplayEnabled = this.autoplayStates?.get(guildId) ?? false;

    if (!isAutoplayEnabled) return false;

    const lastTrack = player.queue.current || player.queue.previous;
    if (!lastTrack) return false;

    const sessionPlayed = this.sessionPlayedTracks.get(guildId) ?? [];
    const queueUris = player.queue.tracks?.map(t => t.uri) || [];

    const extractPrimaryArtist = author => author?.split(',')[0]?.trim() || '';
    const cleanTitle = title => title?.split('(')[0].trim() || '';

    const primaryArtist = extractPrimaryArtist(lastTrack.author);
    const title = cleanTitle(lastTrack.title);

    const createTrackFingerprint = track => {
      const titleWords = cleanTitle(track.title).toLowerCase().split(/\s+/).filter(Boolean);
      const artistNames = (track.author || '').toLowerCase().split(/[,&]/).map(a => a.trim()).filter(Boolean);
      return { titleWords, artistNames };
    };

    const lastTrackFingerprint = createTrackFingerprint(lastTrack);

    const isSimilarTrack = (track) => {
      if (!track.uri || track.uri === lastTrack.uri) return true;

      const fingerprint = createTrackFingerprint(track);

      const titleSimilarity = fingerprint.titleWords.filter(word =>
        lastTrackFingerprint.titleWords.includes(word)).length;

      const artistOverlap = fingerprint.artistNames.filter(artist =>
        lastTrackFingerprint.artistNames.includes(artist)).length;

      const titleSimilarityRatio = titleSimilarity / Math.max(1, lastTrackFingerprint.titleWords.length);

      return (titleSimilarityRatio > 0.6 && artistOverlap > 0);
    };

    const searchQueries = [
      primaryArtist && title ? `similar to ${primaryArtist} ${title}` : null,
      primaryArtist ? `artist:${primaryArtist}` : null,
      lastTrack.genre ? `genre:${lastTrack.genre}` : null,
      title ? `tracks like ${title}` : null,
      'recommended popular tracks'
    ].filter(Boolean);

    let allTracks = [];

    try {
      const searchPromises = searchQueries.map(query =>
        this.kazagumo.search(query, {
          source: 'spsearch:',
          limit: 15
        }).catch(() => ({ tracks: [] }))
      );

      const searchResults = await Promise.all(searchPromises);

      allTracks = searchResults
        .flatMap(result => result.tracks || [])
        .filter(track => !!track?.uri);

      if (!allTracks.length) return false;
    } catch (error) {
      return false;
    }

    const eligibleTracks = allTracks.filter(track => {
      if (!track?.uri) return false;
      if (track.uri === lastTrack.uri) return false;
      if (queueUris.includes(track.uri)) return false;
      if (sessionPlayed.includes(track.uri)) return false;
      if (isSimilarTrack(track)) return false;
      return true;
    });

    if (!eligibleTracks.length) return false;

    const scoredTracks = eligibleTracks.map(track => {
      let score = 0;

      if (lastTrack.author && track.author) {
        const lastArtists = lastTrack.author.toLowerCase().split(/[,&]/).map(a => a.trim()).filter(Boolean);
        const newArtists = track.author.toLowerCase().split(/[,&]/).map(a => a.trim()).filter(Boolean);

        const sharedArtists = newArtists.filter(artist =>
          lastArtists.some(lastArtist => lastArtist.includes(artist) || artist.includes(lastArtist))
        );

        score += sharedArtists.length * 5;

        if (sharedArtists.length === 0) score += 2;
      }

      if (lastTrack.genre && track.genre &&
          lastTrack.genre.toLowerCase() === track.genre.toLowerCase()) {
        score += 3;
      }

      if (lastTrack.length && track.length) {
        const lengthDiff = Math.abs(lastTrack.length - track.length);
        const similarLength = lengthDiff < 60000;
        if (similarLength) score += 2;
      }

      score += Math.random() * 2;

      return { track, score };
    });

    scoredTracks.sort((a, b) => b.score - a.score);

    const newTrack = scoredTracks[0].track;
    newTrack.requester = this.client.user;
    player.queue.add(newTrack);

    sessionPlayed.push(newTrack.uri);
    this.sessionPlayedTracks.set(guildId, sessionPlayed.slice(-100));

    if (!player.playing && !player.paused) {
      player.queue.add(newTrack);
    }

    return true;
  }

  handleVoiceStateUpdate(oldState) {
    if (!oldState.guild) return;
    const player = this.kazagumo.players.get(oldState.guild.id);
    if (!player) return;
    const voiceChannel = oldState.guild.channels.cache.get(player.voiceId);
    if (voiceChannel?.members.filter((m) => !m.user.bot).size === 0) {
      player.destroy();
      this.deleteOldNowPlaying(player);
      this.sessionPlayedTracks.delete(oldState.guild.id);
    }
  }

  handlePlayerStart = async (player, track) => {
    this.isSkipping = false;
    const guildId = player.guildId;
    this.lastPlayedTracks.set(guildId, track);
    const sessionPlayed = this.sessionPlayedTracks.get(guildId) ?? [];
    sessionPlayed.push(track.uri);
    this.sessionPlayedTracks.set(guildId, sessionPlayed);
    await this.taskQueue.enqueue(async () => {
      await this.sendNowPlayingEmbed(player);
    });
  };

  handlePlayerEnd = async (player) => {
    await this.deleteOldNowPlaying(player);
    const guildId = player.guildId;
    const isAutoplayEnabled = this.autoplayStates.get(guildId) ?? false;
    if (isAutoplayEnabled && player.queue.length === 0) {
      await this.taskQueue.enqueue(async () => {
        await this.addRelatedTrack(player);
        if (player.queue.current && !player.playing) {
          await player.play();
          await this.sendNowPlayingEmbed(player);
        }
      });
    } else if (player.queue.length > 0 && !player.playing) {
      await this.taskQueue.enqueue(async () => {
        await player.play();
        await this.sendNowPlayingEmbed(player);
      });
    }
  };
}

class InteractionHandler {
  constructor(quickMusic) {
    this.quickMusic = quickMusic;
    this.commandAliases = {
      play: ['p', 'spotify'],
      stats: ['s', 'statistics'],
      help: ['h', '?']
    };
    this.queuePages = new Map();
  }

  getQueuePage(player, page) {
    const pageSize = 10;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const queueList = player.queue.slice(start, end);
    const totalPages = Math.ceil(player.queue.length / pageSize) || 1;

    const embedDesc = queueList.length
      ? queueList
          .map(
            (t, i) =>
              `${start + i + 1}. [${t.title}](${t.uri})\n- Requested By: <@${t.requester?.id ?? this.quickMusic.client.user.id}>`
          )
          .join('\n\n')
      : 'No songs in queue.';

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('queue_prev')
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 1),
      new ButtonBuilder()
        .setCustomId('queue_next')
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages || queueList.length < pageSize)
    );

    return {
      embed: this.quickMusic.createEmbed(`Queue Page: ${page}`, embedDesc),
      components: [row]
    };
  }

  handleMessage = async (message) => {
    const prefixRegex = new RegExp(
      `^(?:${this.quickMusic.config.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|<@!?${this.quickMusic.client.user.id}>)(?:\\s+)?`
    );
    if (!prefixRegex.test(message.content) || message.author.bot) return;

    const matchedPrefix = message.content.match(prefixRegex)[0];
    const commandContent = message.content.slice(matchedPrefix.length).trim();
    if (!commandContent) return;

    const args = commandContent.split(/\s+/);
    const command = args.shift()?.toLowerCase();

    const resolvedCommand = Object.keys(this.commandAliases).find(
      (cmd) => cmd === command || this.commandAliases[cmd].includes(command)
    );
    if (!resolvedCommand) return;

    if (resolvedCommand === 'play') {
      await this.handlePlayCommand(message, args.join(' '));
    } else if (resolvedCommand === 'stats') {
      await this.handleStatsCommand(message);
    } else if (resolvedCommand === 'help') {
      await this.handleHelpCommand(message);
    }
  };

  handleButton = async (interaction) => {
    const player = this.quickMusic.kazagumo.players.get(interaction.guild.id);
    if (!player) {
      return interaction.reply({
        embeds: [this.quickMusic.createEmbed('Error', 'No active player.')],
        flags: 64
      });
    }
    if (
      !interaction.member.voice.channel ||
      interaction.member.voice.channel.id !== player.voiceId
    ) {
      return interaction.reply({
        embeds: [
          this.quickMusic.createEmbed(
            'Error',
            'You must be in the same voice channel.'
          )
        ],
        flags: 64
      });
    }

    if (interaction.customId === 'lyrics') {
      return this.handleLyricsButton(interaction, player);
    }

    if (!['queue', 'queue_prev', 'queue_next'].includes(interaction.customId)) {
      await interaction.deferReply({ flags: 64 });
    }

    let embedTitle = '';
    let embedDesc = '';
    switch (interaction.customId) {
      case 'pause':
        ({ embedTitle, embedDesc } = await this.handlePauseButton(player, interaction));
        break;
      case 'skip':
        ({ embedTitle, embedDesc } = await this.handleSkipButton(player, interaction));
        break;
      case 'stop':
        player.destroy();
        embedTitle = 'Stopped';
        embedDesc = 'Stopped the music and left the voice channel.';
        await this.quickMusic.deleteOldNowPlaying(player);
        await this.quickMusic.deleteOldQueueMessage(interaction.guild.id);
        this.quickMusic.sessionPlayedTracks.delete(interaction.guild.id);
        break;
      case 'loop':
        player.setLoop(player.loop === 'none' ? 'track' : 'none');
        embedTitle = player.loop === 'track' ? 'Loop Enabled' : 'Loop Disabled';
        embedDesc =
          player.loop === 'track'
            ? 'Track will loop continuously.'
            : 'Looping is now disabled.';
        break;
      case 'queue':
        await this.quickMusic.deleteOldQueueMessage(interaction.guild.id);
        this.queuePages.set(interaction.guild.id, 1);
        const { embed, components } = this.getQueuePage(player, 1);
        const msg = await interaction.reply({
          embeds: [embed],
          components,
          flags: 64
        });
        this.quickMusic.queueMessages.set(interaction.guild.id, msg);
        return;
      case 'queue_prev':
        {
          const currentPage = this.queuePages.get(interaction.guild.id) || 1;
          const newPage = Math.max(1, currentPage - 1);
          this.queuePages.set(interaction.guild.id, newPage);
          const { embed, components } = this.getQueuePage(player, newPage);
          await interaction.update({
            embeds: [embed],
            components
          });
          return;
        }
      case 'queue_next':
        {
          const currentPage = this.queuePages.get(interaction.guild.id) || 1;
          const totalPages = Math.ceil(player.queue.length / 10) || 1;
          const newPage = Math.min(totalPages, currentPage + 1);
          this.queuePages.set(interaction.guild.id, newPage);
          const { embed, components } = this.getQueuePage(player, newPage);
          await interaction.update({
            embeds: [embed],
            components
          });
          return;
        }
      case 'vol_up':
        if (player.volume >= 100) {
          embedTitle = 'Volume Error';
          embedDesc = 'Cannot increase volume beyond 100%.';
        } else {
          const newVolume = Math.min(player.volume + 10, 100);
          await player.setVolume(newVolume);
          embedTitle = 'Volume Updated';
          embedDesc = `Volume increased to ${newVolume}%.`;
        }
        break;
      case 'vol_down':
        if (player.volume <= 0) {
          embedTitle = 'Volume Error';
          embedDesc = 'Volume is already at 0%.';
        } else {
          const newVolume = Math.max(player.volume - 10, 0);
          await player.setVolume(newVolume);
          embedTitle = 'Volume Updated';
          embedDesc = `Volume decreased to ${newVolume}%.`;
        }
        break;
      case 'autoplay':
        {
          const isAutoplayEnabled =
            !this.quickMusic.autoplayStates.get(interaction.guild.id);
          this.quickMusic.autoplayStates.set(interaction.guild.id, isAutoplayEnabled);
          embedTitle = isAutoplayEnabled ? 'Autoplay Enabled' : 'Autoplay Disabled';
          embedDesc = isAutoplayEnabled
            ? 'Autoplay is now enabled.'
            : 'Autoplay is now disabled.';
          const nowMsg = this.quickMusic.nowPlayingMessages.get(interaction.guild.id);
          if (nowMsg) {
            await nowMsg.edit({
              components: this.quickMusic.getControlButtons(
                player.paused,
                isAutoplayEnabled
              )
            });
          }
          if (isAutoplayEnabled && player.queue.current && player.queue.length <= 1) {
            await this.quickMusic.taskQueue.enqueue(async () => {
              await this.quickMusic.addRelatedTrack(player);
              if (player.queue.length > 1 && !player.playing) {
                await player.skip();
                await this.quickMusic.sendNowPlayingEmbed(player);
              }
            });
          }
        }
        break;
    }
    await interaction.editReply({
      embeds: [this.quickMusic.createEmbed(embedTitle, embedDesc)]
    });
  }

  handlePlayCommand = async (message, query) => {
    if (!message.member.voice.channel) {
      return message.reply({
        embeds: [this.quickMusic.createEmbed('Error', 'You must be in a voice channel.')]
      });
    }
    try {
      let player = this.quickMusic.kazagumo.players.get(message.guild.id);
      if (!player || player.destroyed) {
        player = await this.quickMusic.kazagumo.createPlayer({
          guildId: message.guild.id,
          textId: message.channel.id,
          voiceId: message.member.voice.channel.id,
          volume: 90,
          quality: 'very_high',
          bitrate: 320000,
          sampleRate: 44100,
          crossfade: 5,
          leaveOnEnd: false,
          leaveOnStop: true,
          bufferSize: 5000,
          repositionTracks: true,
          autoPlay: true,
          preload: true,
          reconnectTries: 5,
          reconnectTimeout: 5000,
          deaf: true,
          smoothVolume: true
        });
        await player.setVoiceChannel(message.member.voice.channel.id);
        this.quickMusic.autoplayStates.set(message.guild.id, false);
        this.quickMusic.sessionPlayedTracks.set(message.guild.id, []);
      }
      if (!player.connected) {
        try {
          await player.connect();
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (error) {
          if (error.code !== 1) throw error;
        }
      }
      if (!query) {
        return message.reply({
          embeds: [
            this.quickMusic.createEmbed('Error', 'Please provide a song name or URL.')
          ]
        });
      }

      const isUrl = (string) => {
        try {
          new URL(string);
          return true;
        } catch {
          return false;
        }
      };

      let finalQuery = query;
      let searchOptions = { requester: message.author };
      let sourceName = 'spotify';

      if (isUrl(query)) {
        if (
          query.includes('youtube.com') ||
          query.includes('youtu.be') ||
          query.includes('music.youtube.com')
        ) {
          searchOptions.source = 'youtube';
          sourceName = 'youtube';
        } else if (query.includes('spotify.com') || query.includes('spotify:')) {
          searchOptions.source = 'spotify';
        } else if (query.includes('apple.com') || query.includes('music.apple.com')) {
          searchOptions.source = 'applemusic';
          sourceName = 'applemusic';
        } else if (query.includes('soundcloud.com')) {
          searchOptions.source = 'soundcloud';
          sourceName = 'soundcloud';
        } else {
          return message.reply({
            embeds: [
              this.quickMusic.createEmbed(
                'Error',
                'Only YouTube, Spotify, Apple Music, or SoundCloud URLs are allowed.'
              )
            ]
          });
        }
      } else {
        searchOptions.source = 'spsearch:';
      }

      if (query.includes('music.apple.com') && query.includes('playlist')) {
        searchOptions.source = 'applemusic';
        sourceName = 'applemusic';
      }

      const search = await this.quickMusic.kazagumo.search(finalQuery, searchOptions).catch((err) => {
        return { tracks: [] };
      });

      const tracks = search.tracks;
      if (!tracks.length) {
        return message.reply({
          embeds: [
            this.quickMusic.createEmbed(
              'No Results',
              `No results found on ${
                sourceName === 'youtube'
                  ? 'YouTube'
                  : sourceName === 'applemusic'
                  ? 'Apple Music'
                  : sourceName === 'soundcloud'
                  ? 'SoundCloud'
                  : 'Spotify'
              }. Try a different query.`
            )
          ]
        });
      }

      const filteredTracks = tracks.filter((track) => track.sourceName === sourceName);
      if (!filteredTracks.length) {
        return message.reply({
          embeds: [
            this.quickMusic.createEmbed(
              'Error',
              `Found tracks, but none from ${
                sourceName === 'youtube'
                  ? 'YouTube'
                  : sourceName === 'applemusic'
                  ? 'Apple Music'
                  : sourceName === 'soundcloud'
                  ? 'SoundCloud'
                  : 'Spotify'
              }. Try a different query or source.`
            )
          ]
        });
      }

      if (
        query.includes('playlist') ||
        finalQuery.includes('open.spotify.com/playlist') ||
        finalQuery.includes('spotify:playlist') ||
        finalQuery.includes('youtube.com/playlist') ||
        finalQuery.includes('music.apple.com/playlist') ||
        finalQuery.includes('soundcloud.com/sets')
      ) {
        const currentQueueLength = player.queue.length;
        const availableSlots = 500 - currentQueueLength;
        let selectedTracks = filteredTracks;
        let warningMessage = '';

        if (availableSlots <= 0) {
          return message.reply({
            embeds: [
              this.quickMusic.createEmbed(
                'Playlist Added',
                `Added 0 song(s) from playlist. Queue is full (500 tracks).`
              )
            ]
          });
        }

        if (selectedTracks.length > availableSlots) {
          selectedTracks = selectedTracks.slice(0, availableSlots);
          warningMessage = ' Queue is now full; excess tracks were trimmed.';
        }

        const chunkSize = 50;
        for (let i = 0; i < selectedTracks.length; i += chunkSize) {
          const chunk = selectedTracks.slice(i, i + chunkSize);
          for (const track of chunk) {
            if (!player.queue.some((t) => t.uri === track.uri)) {
              track.requester = message.author;
              player.queue.add(track);
            }
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        await message.reply({
          embeds: [
            this.quickMusic.createEmbed(
              'Playlist Added',
              `Added ${selectedTracks.length} song(s) from ${
                sourceName === 'youtube'
                  ? 'YouTube'
                  : sourceName === 'applemusic'
                  ? 'Apple Music'
                  : sourceName === 'soundcloud'
                  ? 'SoundCloud'
                  : 'Spotify'
              } playlist.${warningMessage}`
            )
          ]
        });
      } else {
        const track = filteredTracks[0];
        track.requester = message.author;
        if (player.queue.some((t) => t.uri === track.uri)) {
          return message.reply({
            embeds: [
              this.quickMusic.createEmbed('Duplicate', 'This track is already in the queue.')
            ]
          });
        }
        player.queue.add(track);
        this.quickMusic.lastPlayedTracks.set(message.guild.id, track);
        await message.reply({
          embeds: [this.quickMusic.createEmbed('Track Queued', `${track.title}`)]
        });
      }

      if (!player.playing && player.queue.current) {
        await this.quickMusic.taskQueue.enqueue(async () => {
          await this.quickMusic.deleteOldNowPlaying(player);
          await player.play();
        });
      }
    } catch (err) {
      console.error('Error in play command:', err);
      if (err.message.includes('Missing Permissions')) {
        return message.reply({
          embeds: [
            this.quickMusic.createEmbed(
              'Error',
              'I lack permission to join your voice channel.'
            )
          ]
        });
      }
      return message.reply({
        embeds: [
          this.quickMusic.createEmbed(
            'Error',
            'An error occurred while processing your request.'
          )
        ]
      });
    }
  };

  handleStatsCommand = async (message) => {
    const initialMsg = await message.reply({
      embeds: [this.quickMusic.createEmbed('Fetching Statistics', 'Please wait...')]
    });

    const formatUptime = (uptimeMs) => {
      const uptimeSeconds = Math.floor(uptimeMs / 1000);
      const days = Math.floor(uptimeSeconds / (24 * 3600));
      const hours = Math.floor((uptimeSeconds % (24 * 3600)) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;
      return `${days}d ${hours}h ${minutes}m ${seconds}s`;
    };

    const bytesToGB = (bytes) => (bytes / 1024 / 1024 / 1024).toFixed(2);

    const clientUptime = this.quickMusic.client.uptime;
    const totalGuilds = this.quickMusic.client.guilds.cache.size;
    const totalUsers = this.quickMusic.client.users.cache.size;
    const wsLatency = this.quickMusic.client.ws.ping;

    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    const lavalinkNode = this.quickMusic.kazagumo.shoukaku.nodes.get(this.quickMusic.config.lavalink.name);
    const lavalinkStats = lavalinkNode?.stats || {
      players: 0,
      playingPlayers: 0,
      memory: { allocated: 0, used: 0, free: 0 },
      uptime: 0
    };

    const embed = this.quickMusic.createEmbed(
      'QuickMusic | v1.5',
      `🤖 | **Client Stats**\n` +
      `• Shard: **0** | **Online**\n` +
      `• Guild: **${totalGuilds}**\n` +
      `• Users: **${totalUsers}**\n` +
      `• API Latency: **${wsLatency}ms**\n` +
      `• Uptime: **${formatUptime(clientUptime)}**\n\n` +
      `💽 | **System Stats**\n` +
      `• Total Memory: **${bytesToGB(totalMemory)}GB**\n` +
      `• Used Memory: **${bytesToGB(usedMemory)}GB**\n` +
      `• Free Memory: **${bytesToGB(freeMemory)}GB**\n\n` +
      `🎶 | **Lavalink Stats**\n` +
      `• Lavalink Name: **${this.quickMusic.config.lavalink.name}** | **v4**\n` +
      `• Players: **${lavalinkStats.players}**\n` +
      `• Total Memory: **${bytesToGB(lavalinkStats.memory.allocated)}GB**\n` +
      `• Used Memory: **${bytesToGB(lavalinkStats.memory.used)}GB**\n` +
      `• Free Memory: **${bytesToGB(lavalinkStats.memory.free)}GB**\n` +
      `• Uptime: **${formatUptime(lavalinkStats.uptime)}**\n\n` +
      `ℹ️ | **Version Info**\n` +
      `• discord.js: **v14.18.0**\n` +
      `• nodejs: **v23.11.0**\n` +
      `• kazagumo: **v3.2.2**`
    );

    await initialMsg.edit({
      embeds: [embed]
    });
  };

  handleLyricsButton = async (interaction, player) => {
    await interaction.deferReply({ flags: 64 });
    const track = player.queue.current;
    if (!track) {
      return interaction.editReply({
        embeds: [this.quickMusic.createEmbed('Error', 'No active player.')]
      });
    }
    await interaction.editReply({
      embeds: [this.quickMusic.createEmbed('Fetching Lyrics', 'Please wait...')]
    });
    let title = track.title;
    let artist = track.author ?? '';
    if (title.includes(' - ') && !artist) {
      const [artistPart, titlePart] = title.split(' - ');
      artist = artistPart.trim();
      title = titlePart.trim();
    }
    const lyrics = await this.quickMusic.fetchLyrics(title, artist);
    if (lyrics) {
      if (lyrics.length > 4000) {
        const firstPart = lyrics.substring(0, 4000);
        await interaction.editReply({
          embeds: [
            this.quickMusic.createEmbed(
              `Lyrics for ${track.title}`,
              `${firstPart}\n\n(Lyrics truncated due to length)`
            )
          ]
        });
      } else {
        await interaction.editReply({
          embeds: [this.quickMusic.createEmbed(`Lyrics for ${track.title}`, lyrics)]
        });
      }
    } else {
      await interaction.editReply({
        embeds: [this.quickMusic.createEmbed('No Results', 'No lyrics found.')]
      });
    }
  };

  handleHelpCommand = async (message) => {
    const embed = this.quickMusic.createEmbed(
      'QuickMusic | v1.5',
      `Hello, Thank you for using QuickMusic.\n` +
        `To play a song join a voice channel and use\n` +
        `\`${this.quickMusic.config.prefix}play <song name or URL>\`\n\n` +
        `Once you play a song, you will see the rest of the commands/controls through buttons.\n\n` +
        `**About QuickMusic**\n` +
        `QuickMusic is an open source Discord music bot project made by \`@sakshamyep\`. ` +
        `To view the source code, features, and license, click the button below.`
    );

    const sourceCodeButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Source Code')
        .setStyle(ButtonStyle.Link)
        .setURL('https://github.com/sakshamyep/QuickMusic')
    );

    await message.reply({
      embeds: [embed],
      components: [sourceCodeButton]
    });
  };

  handlePauseButton = async (player, interaction) => {
    player.pause(!player.paused);
    const embedTitle = player.paused ? 'Paused' : 'Resumed';
    const embedDesc = player.paused ? 'Paused the music.' : 'Resumed the music.';
    const isAutoplayEnabled = this.quickMusic.autoplayStates.get(interaction.guild.id) ?? false;
    const nowMsg = this.quickMusic.nowPlayingMessages.get(interaction.guild.id);
    if (nowMsg) {
      await nowMsg.edit({
        components: this.quickMusic.getControlButtons(player.paused, isAutoplayEnabled)
      });
    }
    return { embedTitle, embedDesc };
  };

  handleSkipButton = async (player, interaction) => {
    if (!this.quickMusic.isSkipping) {
      this.quickMusic.isSkipping = true;
      await this.quickMusic.deleteOldNowPlaying(player);
      player.skip();
      const guildId = interaction.guild.id;
      const isAutoplayEnabled = this.quickMusic.autoplayStates.get(guildId) ?? false;
      if (isAutoplayEnabled && player.queue.length === 0) {
        await this.quickMusic.taskQueue.enqueue(async () => {
          await this.quickMusic.addRelatedTrack(player);
          if (player.queue.current && !player.playing) {
            await player.play();
          }
        });
      }
      if (!player.playing && player.queue.current) {
        await this.quickMusic.taskQueue.enqueue(async () => {
          await player.play();
        });
      }
      await this.quickMusic.deleteOldQueueMessage(guildId);
      this.quickMusic.isSkipping = false;
      return { embedTitle: 'Skipped', embedDesc: 'Skipped the track.' };
    }
    return {
      embedTitle: 'Skip In Progress',
      embedDesc: 'Already skipping a track.'
    };
  };
}

const quickMusic = new QuickMusic();
const interactionHandler = new InteractionHandler(quickMusic);

quickMusic.kazagumo.shoukaku.on('ready', (name) => console.log(`🟢 Node Connected: ${name}`));
quickMusic.kazagumo.shoukaku.on('disconnect', (name, reason) => {
  console.warn(`🔴 Node Disconnected`);
  setTimeout(async () => {
    await quickMusic.kazagumo.shoukaku.connect(quickMusic.config.lavalink);
    console.log(`🟢 Reconnected to Node: ${name}`);
  }, 3000);
});

quickMusic.kazagumo.shoukaku.on('error', (name, error) => console.error(`🟡 Node Error [${name}]:`, error));
quickMusic.kazagumo.on('playerStart', quickMusic.handlePlayerStart);
quickMusic.kazagumo.on('playerEnd', async (player) => {
  try {
    await quickMusic.deleteOldNowPlaying(player);
    const guildId = player.guildId;
    const isAutoplayEnabled = quickMusic.autoplayStates.get(guildId) ?? false;
    await quickMusic.deleteOldNowPlaying(player);
    quickMusic.nowPlayingMessages.delete(player.guildId);
  } catch (error) {}
});
quickMusic.kazagumo.on('playerException', async (player, error) => {
  if (!player.connected) {
    await player.connect();
    if (player.queue.current) await player.play();
  }
});

quickMusic.client.once('ready', async () => {
  quickMusic.client.user.setPresence({
    activities: [
      {
        name: `${quickMusic.config.prefix}play`,
        type: ActivityType.Listening
      }
    ],
    status: 'dnd'
  });
});

quickMusic.client.on('voiceStateUpdate', (oldState) => quickMusic.handleVoiceStateUpdate(oldState));
quickMusic.client.on('guildDelete', (guild) => {});
quickMusic.client.on('channelDelete', (channel) => {});
quickMusic.client.on('messageCreate', (message) => interactionHandler.handleMessage(message));
quickMusic.client.on('interactionCreate', (interaction) => {
  if (interaction.isButton()) interactionHandler.handleButton(interaction);
});

process.on('unhandledRejection', (error) =>
  console.error('Unhandled Rejection:', error)
);
process.on('uncaughtException', (error) =>
  console.error('Uncaught Exception:', error)
);

const startBot = async () => {
  try {
    await quickMusic.client.login(quickMusic.config.token);
    console.log('✅ Logged in successfully.');
  } catch (error) {
    console.error('❌ Failed to login:', error);
  }
};
startBot();
/**
 * QuickMusic | v1.5
 * Copyright (c) 2025 Saksham Pandey
 */