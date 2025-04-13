/**
 * QuickMusic | v1.2
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
  ActivityType,
} from 'discord.js';
import { Kazagumo } from 'kazagumo';
import { Connectors } from 'shoukaku';
import axios from 'axios';

class QuickMusic {
  constructor() {
    this.config = {
      token: process.env.TOKEN,
      prefix: process.env.BOT_PREFIX,
      lavalink: {
        name: process.env.LAVALINK_NAME,
        url: process.env.LAVALINK_URL,
        auth: process.env.LAVALINK_AUTH,
        secure: process.env.LAVALINK_SECURE === 'true',
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
        defaultSearchEngine: 'youtube_music',
        send: (guildId, payload) => {
          const guild = this.client.guilds.cache.get(guildId);
          if (guild) guild.shard.send(payload);
        },
        options: {
          bufferTimeout: 800,
          maxRetries: 3,
          retryDelay: 1500,
        },
      },
      new Connectors.DiscordJS(this.client),
      [
        {
          ...this.config.lavalink,
          retryCount: 3,
          retryDelay: 1500,
        },
      ]
    );
    this.nowPlayingMessages = new Map();
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

  async deleteOldNowPlaying(player) {
    const oldMsg = this.nowPlayingMessages.get(player.guildId);
    if (oldMsg) {
      try {
        await oldMsg.delete();
      } catch (error) {
        if (error.code !== 10008) {
          return;
        }
      }
      this.nowPlayingMessages.delete(player.guildId);
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
        components: this.getControlButtons(player.paused, isAutoplayEnabled),
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
    const guildId = player.guildId;
    const lastTrack = this.lastPlayedTracks.get(guildId) ?? player.queue.current;
    if (!lastTrack) return;

    const primaryArtist = lastTrack.author?.split(',')[0]?.trim() ?? '';
    const sessionPlayed = this.sessionPlayedTracks.get(guildId) ?? [];
    let baseQuery = primaryArtist ? `${primaryArtist} music` : lastTrack.title.split('(')[0].trim();
    baseQuery += ' -live -remix -cover -acoustic -instrumental';

    const searchPromises = [
        this.kazagumo.search(baseQuery, {
            searchEngine: 'youtube_music',
            limit: 10
        }).catch(() => ({ tracks: [] })),
        this.kazagumo.search(baseQuery, {
            searchEngine: 'spotify',
            limit: 10
        }).catch(() => ({ tracks: [] }))
    ];

    const results = await Promise.all(searchPromises);
    const [youtubeResults, spotifyResults] = results;
    let allTracks = [
        ...(youtubeResults?.tracks || []),
        ...(spotifyResults?.tracks || [])
    ];

    if (!allTracks.length) {
        baseQuery = `${lastTrack.title.split('(')[0].trim()} similar songs`;
        const fallbackResults = await this.kazagumo.search(baseQuery, {
            searchEngine: 'youtube_music',
            limit: 10
        }).catch(() => ({ tracks: [] }));
        allTracks = fallbackResults.tracks || [];
    }

    if (!allTracks.length) return;
    const currentUri = lastTrack.uri;
    const currentDuration = lastTrack.length ?? 0;
    const currentTitleWords = lastTrack.title.toLowerCase().split(/\s+/);

    const scoredTracks = allTracks
        .filter(track => 
            track.uri !== currentUri &&
            !sessionPlayed.includes(track.uri) &&
            track.length && 
            Math.abs(track.length - currentDuration) < 120000
        )
        .map(track => {
            let score = 0;
            const trackArtist = track.author?.toLowerCase() || '';
            if (trackArtist.includes(primaryArtist.toLowerCase())) {
                score += 50;
            }
            const trackTitleWords = track.title.toLowerCase().split(/\s+/);
            const commonWords = trackTitleWords.filter(word => 
                currentTitleWords.includes(word) && word.length > 3
            ).length;
            score += commonWords * 5;
            const durationDiff = Math.abs((track.length ?? 0) - currentDuration);
            score += Math.max(0, 20 - durationDiff / 10000);
            if (track.sourceName === 'spotify') {
                score += 10;
            }

            return { track, score };
        }).sort((a, b) => b.score - a.score);
    const topTracks = scoredTracks.slice(0, 3);
    if (!topTracks.length) return;
    const selected = topTracks[Math.floor(Math.random() * Math.min(topTracks.length, 3))];
    const track = selected.track;
    track.requester = this.client.user;
    player.queue.add(track);
    sessionPlayed.push(track.uri);
    this.sessionPlayedTracks.set(guildId, sessionPlayed);

    if (!player.playing && player.queue.length === 1) {
        await this.taskQueue.enqueue(async () => {
            await player.play();
        });
}};

  handleVoiceStateUpdate = (oldState) => {
    if (!oldState.guild) return;
    const player = this.kazagumo.players.get(oldState.guild.id);
    if (!player) return;
    const voiceChannel = oldState.guild.channels.cache.get(player.voiceId);
    if (voiceChannel?.members.filter((m) => !m.user.bot).size === 0) {
      player.destroy();
      this.deleteOldNowPlaying(player);
      this.sessionPlayedTracks.delete(oldState.guild.id);
    }
  };

  handleGuildDelete = (guild) => {
    const player = this.kazagumo.players.get(guild.id);
    if (player) player.destroy();
    const oldMsg = this.nowPlayingMessages.get(guild.id);
    if (oldMsg) {
      oldMsg.delete().catch(() => {});
      this.nowPlayingMessages.delete(guild.id);
    }
    this.sessionPlayedTracks.delete(guild.id);
  };

  handleChannelDelete = (channel) => {
    if (channel.type === 'GUILD_VOICE') {
      const player = this.kazagumo.players.get(channel.guild.id);
      if (player && player.voiceId === channel.id) {
        player.destroy();
        this.deleteOldNowPlaying(player);
        this.sessionPlayedTracks.delete(channel.guild.id);
      }
    }
  };

  handlePlayerStart = async (player, track) => {
    this.isSkipping = false;
    const guildId = player.guildId;
    this.lastPlayedTracks.set(guildId, track);
    const sessionPlayed = this.sessionPlayedTracks.get(guildId) ?? [];
    sessionPlayed.push(track.uri);
    this.sessionPlayedTracks.set(guildId, sessionPlayed);
    if (player.voice) await player.voice.setSelfDeaf(true);
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
          if (player.voice) await player.voice.setSelfDeaf(true);
          await this.sendNowPlayingEmbed(player);
        }
      });
    } else if (player.queue.length > 0 && !player.playing) {
      await this.taskQueue.enqueue(async () => {
        await player.play();
        if (player.voice) await player.voice.setSelfDeaf(true);
        await this.sendNowPlayingEmbed(player);
      });
    }
  };
}

class InteractionHandler {
  constructor(quickMusic) {
    this.quickMusic = quickMusic;
    this.commandAliases = {
      play: ['p'],
      ping: ['latency'],
      help: ['h', '?'],
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
    } else if (resolvedCommand === 'ping') {
      await this.handlePingCommand(message);
    } else if (resolvedCommand === 'help') {
      await this.handleHelpCommand(message);
    }
  };

  handleButton = async (interaction) => {
    const player = this.quickMusic.kazagumo.players.get(interaction.guild.id);
    if (!player) {
      return interaction.reply({
        embeds: [this.quickMusic.createEmbed('Error', 'No active player.')],
        flags: 64,
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
          ),
        ],
        flags: 64,
      });
    }

    if (interaction.customId === 'lyrics') {
      return this.handleLyricsButton(interaction, player);
    }

    await interaction.deferReply({ flags: 64, });
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
        {
          const queueList = player.queue.slice(0, 20);
          embedTitle = 'First 20 Songs in Queue';
          embedDesc = queueList.length
            ? queueList.map((t, i) => `${i + 1}. ${t.title}`).join('\n')
            : 'No songs in queue.';
        }
        break;
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
              ),
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
      embeds: [this.quickMusic.createEmbed(embedTitle, embedDesc)],
    });
  };

  handlePlayCommand = async (message, query) => {
    if (!message.member.voice.channel) {
      return message.reply({
        embeds: [this.quickMusic.createEmbed('Error', 'You must be in a voice channel.')],
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
          quality: 'high',
          bitrate: 256000,
          sampleRate: 48000,
          crossfade: 2,
          leaveOnEnd: false,
          leaveOnStop: true,
          bufferSize: 10000,
          repositionTracks: true,
          autoPlay: true,
        });
        await player.setVoiceChannel(message.member.voice.channel.id, {
          selfDeaf: true,
        });
        this.quickMusic.autoplayStates.set(message.guild.id, false);
        this.quickMusic.sessionPlayedTracks.set(message.guild.id, []);
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
        return message.reply({
          embeds: [
            this.quickMusic.createEmbed('Error', 'Please provide a song name or URL.'),
          ],
        });
      }
      let searchEngine = 'youtube_music';
      if (query.includes('spotify.com') || query.includes('spotify:')) {
        searchEngine = 'spotify';
      } else if (query.includes('soundcloud.com')) {
        searchEngine = 'soundcloud';
      }
      const search = await this.quickMusic.kazagumo.search(query, {
        requester: message.author,
        searchEngine,
      });
      const tracks = search.tracks;
      if (!tracks.length) {
        return message.reply({
          embeds: [this.quickMusic.createEmbed('No Results', 'No results found.')],
        });
      }
      if (
        query.includes('playlist') ||
        query.includes('open.spotify.com') ||
        query.includes('youtube.com/playlist')
      ) {
        const currentQueueLength = player.queue.length;
        const availableSlots = 100 - currentQueueLength;
        let selectedTracks = tracks;
        let warningMessage = '';
        if (availableSlots <= 0) {
          return message.reply({
            embeds: [
              this.quickMusic.createEmbed(
                'Playlist Added',
                'Added 0 song(s) from playlist. Warning: Queue is already full (100 tracks).'
              ),
            ],
          });
        }
        if (selectedTracks.length > availableSlots) {
          selectedTracks = selectedTracks.slice(0, availableSlots);
          warningMessage = ' Warning: Queue is now full; excess tracks were trimmed.';
        }
        for (const track of selectedTracks) {
          track.requester = message.author;
          player.queue.add(track);
        }
        await message.reply({
          embeds: [
            this.quickMusic.createEmbed(
              'Playlist Added',
              `Added ${selectedTracks.length} song(s) from playlist.${warningMessage}`
            ),
          ],
        });
      } else {
        const track = tracks[0];
        track.requester = message.author;
        if (player.queue.some((t) => t.uri === track.uri)) {
          return message.reply({
            embeds: [
              this.quickMusic.createEmbed(
                'Duplicate',
                'This track is already in the queue.'
              ),
            ],
          });
        }
        player.queue.add(track);
        this.quickMusic.lastPlayedTracks.set(message.guild.id, track);
        await message.reply({
          embeds: [this.quickMusic.createEmbed('Track Queued', `${track.title}`)],
        });
      }
      if (!player.playing && player.queue.current) {
        await this.quickMusic.taskQueue.enqueue(async () => {
          await this.quickMusic.deleteOldNowPlaying(player);
          await player.play();
          if (player.voice) await player.voice.setSelfDeaf(true);
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
            ),
          ],
        });
      }
      return message.reply({
        embeds: [
          this.quickMusic.createEmbed(
            'Error',
            'An error occurred while processing your request.'
          ),
        ],
      });
    }
  };

  handleLyricsButton = async (interaction, player) => {
    await interaction.deferReply({ flags: 64, });
    const track = player.queue.current;
    if (!track) {
      return interaction.editReply({
        embeds: [this.quickMusic.createEmbed('Error', 'No active player.')],
      });
    }
    await interaction.editReply({
      embeds: [this.quickMusic.createEmbed('Fetching Lyrics', 'Please wait...')],
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
            ),
          ],
        });
      } else {
        await interaction.editReply({
          embeds: [this.quickMusic.createEmbed(`Lyrics for ${track.title}`, lyrics)],
        });
      }
    } else {
      await interaction.editReply({
        embeds: [this.quickMusic.createEmbed('No Results', 'No lyrics found.')],
      });
    }
  };

  handlePingCommand = async (message) => {
    const startTime = Date.now();
    const initialMsg = await message.reply({
      embeds: [this.quickMusic.createEmbed('Pinging...', 'Calculating...')],
    });

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
      embeds: [
        this.quickMusic.createEmbed(
          'Pong!',
          `• Websocket Latency: **${wsLatency}ms**\n` +
            `• Message Latency: **${messageLatency}ms**\n` +
            `• Uptime: **${uptimeStr}**`
        ),
      ],
    });
  };

  handleHelpCommand = async (message) => {
    const embed = this.quickMusic.createEmbed(
      'QuickMusic | v1.2',
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
      components: [sourceCodeButton],
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
        components: this.quickMusic.getControlButtons(player.paused, isAutoplayEnabled),
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
            if (player.voice) await player.voice.setSelfDeaf(true);
          }
        });
      }
      if (!player.playing && player.queue.current) {
        await this.quickMusic.taskQueue.enqueue(async () => {
          await player.play();
          if (player.voice) await player.voice.setSelfDeaf(true);
        });
      }
      this.quickMusic.isSkipping = false;
      return { embedTitle: 'Skipped', embedDesc: 'Skipped the track.' };
    }
    return {
      embedTitle: 'Skip In Progress',
      embedDesc: 'Already skipping a track.',
    };
  };
}

const quickMusic = new QuickMusic();
const interactionHandler = new InteractionHandler(quickMusic);

quickMusic.kazagumo.shoukaku.on('ready', (name) => console.log(`✅ Node Connected: ${name}`));
quickMusic.kazagumo.shoukaku.on('disconnect', (name, reason) => {
  console.warn(`❌ Node Disconnected`);
  setTimeout(async () => {
    await quickMusic.kazagumo.shoukaku.connect(quickMusic.config.lavalink);
    console.log(`✅ Reconnected to Node: ${name}`);
  }, 3000);
});

quickMusic.kazagumo.shoukaku.on('error', (name, error) => console.error(`⚠️ Node Error [${name}]:`, error));
quickMusic.kazagumo.on('playerStart', quickMusic.handlePlayerStart);
quickMusic.kazagumo.on('playerEnd', quickMusic.handlePlayerEnd);
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
        type: ActivityType.Listening,
      },
    ],
    status: 'dnd',
  });
});

quickMusic.client.on('voiceStateUpdate', quickMusic.handleVoiceStateUpdate);
quickMusic.client.on('guildDelete', quickMusic.handleGuildDelete);
quickMusic.client.on('channelDelete', quickMusic.handleChannelDelete);
quickMusic.client.on('messageCreate', interactionHandler.handleMessage);
quickMusic.client.on('interactionCreate', (interaction) => { if (interaction.isButton()) interactionHandler.handleButton(interaction);
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
    console.error('Failed to login:', error);
  }
};
startBot();
/**
 * QuickMusic | v1.2
 * Copyright (c) 2025 Saksham Pandey
 */