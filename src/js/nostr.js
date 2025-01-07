// js/nostr.js

import { isDevMode } from './config.js';

const RELAY_URLS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.snort.social',
    'wss://nostr.wine'
];

// Rate limiting for error logs
let errorLogCount = 0;
const MAX_ERROR_LOGS = 100; // Adjust as needed

function logErrorOnce(message, eventContent = null) {
    if (errorLogCount < MAX_ERROR_LOGS) {
        console.error(message);
        if (eventContent) {
            console.log(`Event Content: ${eventContent}`);
        }
        errorLogCount++;
    }
    if (errorLogCount === MAX_ERROR_LOGS) {
        console.error('Maximum error log limit reached. Further errors will be suppressed.');
    }
}

/**
 * A very naive "encryption" function that just reverses the string.
 * In a real app, use a proper crypto library (AES-GCM, ECDH, etc.).
 */
function fakeEncrypt(magnet) {
    return magnet.split('').reverse().join('');
}
function fakeDecrypt(encrypted) {
    return encrypted.split('').reverse().join('');
}

class NostrClient {
    constructor() {
        this.pool = null; 
        this.pubkey = null;
        this.relays = RELAY_URLS;
    }

    /**
     * Initializes the Nostr client by connecting to relays.
     */
    async init() {
        try {
            if (isDevMode) console.log('Connecting to relays...');
            
            this.pool = new window.NostrTools.SimplePool();

            const testFilter = { kinds: [0], limit: 1 }; 
            const connections = this.relays.map(async url => {
                try {
                    return new Promise((resolve) => {
                        const sub = this.pool.sub([url], [testFilter]);
                        
                        let timeout = setTimeout(() => {
                            sub.unsub();
                            if (isDevMode) console.log(`Connection timeout for ${url}`);
                            resolve({ url, success: false });
                        }, 5000);

                        sub.on('event', () => {
                            clearTimeout(timeout);
                            sub.unsub();
                            if (isDevMode) console.log(`Received event from ${url}`);
                            resolve({ url, success: true });
                        });

                        sub.on('eose', () => {
                            clearTimeout(timeout);
                            sub.unsub();
                            if (isDevMode) console.log(`EOSE from ${url}`);
                            resolve({ url, success: true });
                        });
                    });
                } catch (err) {
                    if (isDevMode) console.error(`Failed to connect to relay: ${url}`, err.message);
                    return { url, success: false };
                }
            });

            const results = await Promise.all(connections);
            const successfulRelays = results.filter(r => r.success).map(r => r.url);
            
            if (successfulRelays.length === 0) {
                throw new Error('No relays could be connected.');
            }

            if (isDevMode) {
                console.log(`Connected to ${successfulRelays.length} relay(s):`, successfulRelays);
            }
        } catch (err) {
            console.error('Failed to initialize Nostr client:', err.message);
            throw err;
        }
    }

    /**
     * Logs in the user using a Nostr extension or by entering an NSEC key.
     */
    async login() {
        if (window.nostr) {
            try {
                const pubkey = await window.nostr.getPublicKey();
                this.pubkey = pubkey;
                if (isDevMode) console.log('Logged in with extension. Public key:', this.pubkey);
                return this.pubkey;
            } catch (e) {
                if (isDevMode) console.warn('Failed to get public key from Nostr extension:', e.message);
                throw new Error('Failed to get public key from Nostr extension.');
            }
        } else {
            const nsec = prompt('Enter your NSEC key:');
            if (nsec) {
                try {
                    this.pubkey = this.decodeNsec(nsec);
                    if (isDevMode) console.log('Logged in with NSEC. Public key:', this.pubkey);
                    return this.pubkey;
                } catch (error) {
                    if (isDevMode) console.error('Invalid NSEC key:', error.message);
                    throw new Error('Invalid NSEC key.');
                }
            } else {
                throw new Error('Login cancelled or NSEC key not provided.');
            }
        }
    }

    /**
     * Logs out the user.
     */
    logout() {
        this.pubkey = null;
        if (isDevMode) console.log('User logged out.');
    }

    /**
     * Decodes an NSEC key.
     */
    decodeNsec(nsec) {
        try {
            const { data } = window.NostrTools.nip19.decode(nsec);
            return data;
        } catch (error) {
            throw new Error('Invalid NSEC key.');
        }
    }

    /**
     * Publishes a new video event to all relays (creates a brand-new note).
     */
    async publishVideo(videoData, pubkey) {
        if (!pubkey) {
            throw new Error('User is not logged in.');
        }
    
        if (isDevMode) {
            console.log('Publishing video with data:', videoData);
        }

        // If user sets "isPrivate = true", encrypt the magnet
        let finalMagnet = videoData.magnet;
        if (videoData.isPrivate === true) {
            finalMagnet = fakeEncrypt(finalMagnet);
        }

        // Default version is 1 if not specified
        const version = videoData.version ?? 1;

        const uniqueD = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;

        // Always mark "deleted" false for new posts
        const contentObject = {
            version,
            deleted: false,
            isPrivate: videoData.isPrivate || false,
            title: videoData.title,
            magnet: finalMagnet,
            thumbnail: videoData.thumbnail,
            description: videoData.description,
            mode: videoData.mode
        };

        const event = {
            kind: 30078,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['t', 'video'],
                ['d', uniqueD]
            ],
            content: JSON.stringify(contentObject)
        };

        if (isDevMode) {
            console.log('Event content after stringify:', event.content);
            console.log('Using d tag:', uniqueD);
        }

        try {
            const signedEvent = await window.nostr.signEvent(event);
            if (isDevMode) {
                console.log('Signed event:', signedEvent);
            }

            await Promise.all(this.relays.map(async url => {
                try {
                    await this.pool.publish([url], signedEvent);
                    if (isDevMode) {
                        console.log(`Event published to ${url}`);
                    }
                } catch (err) {
                    if (isDevMode) {
                        console.error(`Failed to publish to ${url}:`, err.message);
                    }
                }
            }));

            return signedEvent;
        } catch (error) {
            if (isDevMode) {
                console.error('Failed to sign event:', error.message);
            }
            throw new Error('Failed to sign event.');
        }
    }

    /**
     * Edits an existing video event by reusing the same "d" tag.
     * Allows toggling isPrivate on/off and re-encrypting or decrypting the magnet.
     */
    // Minimal fix: ensures we only ever encrypt once per edit operation
    async editVideo(originalEvent, updatedVideoData, pubkey) {
        if (!pubkey) {
            throw new Error('User is not logged in.');
        }
        if (originalEvent.pubkey !== pubkey) {
            throw new Error('You do not own this event (different pubkey).');
        }
    
        if (isDevMode) {
            console.log('Editing video event:', originalEvent);
            console.log('New video data:', updatedVideoData);
        }
    
        // Grab the d tag from the original event
        const dTag = originalEvent.tags.find(tag => tag[0] === 'd');
        if (!dTag) {
            throw new Error('This event has no "d" tag, cannot edit as addressable kind=30078.');
        }
        const existingD = dTag[1];
    
        // Parse old content
        const oldContent = JSON.parse(originalEvent.content || '{}');
        if (isDevMode) {
            console.log('Old content:', oldContent);
        }
    
        // Keep old version & deleted status
        const oldVersion = oldContent.version ?? 1;
        const oldDeleted = (oldContent.deleted === true);
        const newVersion = updatedVideoData.version ?? oldVersion;
        
        const oldWasPrivate = (oldContent.isPrivate === true);
    
        // 1) If old was private, decrypt the old magnet once => oldPlainMagnet
        let oldPlainMagnet = oldContent.magnet || '';
        if (oldWasPrivate && oldPlainMagnet) {
            oldPlainMagnet = fakeDecrypt(oldPlainMagnet);
        }
    
        // 2) If updatedVideoData.isPrivate is explicitly set, use that; else keep the old isPrivate
        const newIsPrivate = 
            typeof updatedVideoData.isPrivate === 'boolean'
            ? updatedVideoData.isPrivate
            : (oldContent.isPrivate ?? false);
    
        // 3) The user might type a new magnet or keep oldPlainMagnet
        const userTypedMagnet = (updatedVideoData.magnet || '').trim();
        const finalPlainMagnet = userTypedMagnet || oldPlainMagnet;
    
        // 4) If new is private => encrypt finalPlainMagnet once; otherwise store plaintext
        let finalMagnet = finalPlainMagnet;
        if (newIsPrivate) {
            finalMagnet = fakeEncrypt(finalPlainMagnet);
        }
    
        // Build updated content
        const contentObject = {
            version: newVersion,
            deleted: oldDeleted,
            isPrivate: newIsPrivate,
            title: updatedVideoData.title,
            magnet: finalMagnet,
            thumbnail: updatedVideoData.thumbnail,
            description: updatedVideoData.description,
            mode: updatedVideoData.mode
        };
    
        if (isDevMode) {
            console.log('Building updated content object:', contentObject);
        }
    
        const event = {
            kind: 30078,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['t', 'video'],
                ['d', existingD]
            ],
            content: JSON.stringify(contentObject)
        };
    
        if (isDevMode) {
            console.log('Reusing d tag:', existingD);
            console.log('Updated event content:', event.content);
        }
    
        try {
            const signedEvent = await window.nostr.signEvent(event);
            if (isDevMode) {
                console.log('Signed edited event:', signedEvent);
            }
    
            // Publish to all relays
            await Promise.all(this.relays.map(async url => {
                try {
                    await this.pool.publish([url], signedEvent);
                    if (isDevMode) {
                        console.log(`Edited event published to ${url} (d="${existingD}")`);
                    }
                } catch (err) {
                    if (isDevMode) {
                        console.error(`Failed to publish edited event to ${url}:`, err.message);
                    }
                }
            }));
    
            return signedEvent;
        } catch (error) {
            if (isDevMode) {
                console.error('Failed to sign edited event:', error.message);
            }
            throw new Error('Failed to sign edited event.');
        }
    }    

    /**
     * Soft-delete or hide an existing video by marking content as "deleted: true"
     * and republishing with same (kind=30078, pubkey, d) address.
     */
    async deleteVideo(originalEvent, pubkey) {
        if (!pubkey) {
            throw new Error('User is not logged in.');
        }
        if (originalEvent.pubkey !== pubkey) {
            throw new Error('You do not own this event (different pubkey).');
        }

        if (isDevMode) {
            console.log('Deleting video event:', originalEvent);
        }

        const dTag = originalEvent.tags.find(tag => tag[0] === 'd');
        if (!dTag) {
            throw new Error('This event has no "d" tag, cannot delete as addressable kind=30078.');
        }
        const existingD = dTag[1];

        const oldContent = JSON.parse(originalEvent.content || '{}');
        const oldVersion = oldContent.version ?? 1;

        const contentObject = {
            version: oldVersion,
            deleted: true, 
            title: oldContent.title || '',
            magnet: '',
            thumbnail: '',
            description: 'This video has been deleted.',
            mode: oldContent.mode || 'live',
            isPrivate: oldContent.isPrivate || false
        };

        const event = {
            kind: 30078,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['t', 'video'],
                ['d', existingD]
            ],
            content: JSON.stringify(contentObject)
        };

        if (isDevMode) {
            console.log('Reusing d tag for delete:', existingD);
            console.log('Deleted event content:', event.content);
        }

        try {
            const signedEvent = await window.nostr.signEvent(event);
            if (isDevMode) {
                console.log('Signed deleted event:', signedEvent);
            }

            await Promise.all(this.relays.map(async url => {
                try {
                    await this.pool.publish([url], signedEvent);
                    if (isDevMode) {
                        console.log(`Deleted event published to ${url} (d="${existingD}")`);
                    }
                } catch (err) {
                    if (isDevMode) {
                        console.error(`Failed to publish deleted event to ${url}:`, err.message);
                    }
                }
            }));

            return signedEvent;
        } catch (error) {
            if (isDevMode) {
                console.error('Failed to sign deleted event:', error.message);
            }
            throw new Error('Failed to sign deleted event.');
        }
    }

    /**
     * Fetches videos from all configured relays.
     */
    async fetchVideos() {
        const filter = {
            kinds: [30078],
            '#t': ['video'],
            limit: 1000,
            since: 0
        };
      
        const videoEvents = new Map();

        if (isDevMode) {
            console.log('[fetchVideos] Starting fetch from all relays...');
            console.log('[fetchVideos] Filter:', filter);
        }

        try {
            await Promise.all(
                this.relays.map(async (url) => {
                    if (isDevMode) console.log(`[fetchVideos] Querying relay: ${url}`);
                    
                    try {
                        const events = await this.pool.list([url], [filter]);
                        
                        if (isDevMode) {
                            console.log(`Events from ${url}:`, events.length);
                            if (events.length > 0) {
                                events.forEach((evt, idx) => {
                                    console.log(
                                        `[fetchVideos] [${url}] Event[${idx}] ID: ${evt.id} | pubkey: ${evt.pubkey} | created_at: ${evt.created_at}`
                                    );
                                });
                            }
                        }
                        
                        events.forEach(event => {
                            try {
                                const content = JSON.parse(event.content);

                                // If deleted == true, it overrides older notes
                                if (content.deleted === true) {
                                    videoEvents.delete(event.id);
                                    return;
                                }

                                // If we haven't seen this event.id before, store it
                                if (!videoEvents.has(event.id)) {
                                    videoEvents.set(event.id, {
                                        id: event.id,
                                        version: content.version ?? 1,
                                        isPrivate: content.isPrivate ?? false,
                                        title: content.title || '',
                                        magnet: content.magnet || '',
                                        thumbnail: content.thumbnail || '',
                                        description: content.description || '',
                                        mode: content.mode || 'live',
                                        pubkey: event.pubkey,
                                        created_at: event.created_at,
                                        tags: event.tags
                                    });
                                }
                            } catch (parseError) {
                                if (isDevMode) {
                                    console.error('[fetchVideos] Event parsing error:', parseError);
                                }
                            }
                        });
                    } catch (relayError) {
                        if (isDevMode) {
                            console.error(`[fetchVideos] Error fetching from ${url}:`, relayError);
                        }
                    }
                })
            );

            const videos = Array.from(videoEvents.values())
                .sort((a, b) => b.created_at - a.created_at);

            if (isDevMode) {
                console.log('[fetchVideos] All relays have responded.');
                console.log(`[fetchVideos] Total unique video events: ${videoEvents.size}`);
            }

            return videos;
        } catch (error) {
            if (isDevMode) {
                console.error('FETCH VIDEOS ERROR:', error);
            }
            return [];
        }
    }

    /**
     * Validates video content structure.
     */
    isValidVideo(content) {
        try {
            const isValid = (
                content &&
                typeof content === 'object' &&
                typeof content.title === 'string' &&
                content.title.length > 0 &&
                typeof content.magnet === 'string' &&
                content.magnet.length > 0 &&
                typeof content.mode === 'string' &&
                ['dev', 'live'].includes(content.mode) &&
                (typeof content.thumbnail === 'string' || typeof content.thumbnail === 'undefined') &&
                (typeof content.description === 'string' || typeof content.description === 'undefined')
            );

            if (isDevMode && !isValid) {
                console.log('Invalid video content:', content);
                console.log('Validation details:', {
                    hasTitle: typeof content.title === 'string',
                    hasMagnet: typeof content.magnet === 'string',
                    hasMode: typeof content.mode === 'string',
                    validThumbnail: typeof content.thumbnail === 'string' || typeof content.thumbnail === 'undefined',
                    validDescription: typeof content.description === 'string' || typeof content.description === 'undefined'
                });
            }

            return isValid;
        } catch (error) {
            if (isDevMode) {
                console.error('Error validating video:', error);
            }
            return false;
        }
    }
}

export const nostrClient = new NostrClient();
