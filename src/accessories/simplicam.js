import crypto from 'crypto';
import ip from 'ip';
import dns from 'dns';
import { promisify } from 'util';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-for-homebridge';
import isDocker from 'is-docker';
import jpegExtract from 'jpeg-extract';

import {
    EVENT_TYPES,
    RateLimitError,
    SOCKET_RETRY_INTERVAL
} from '../simplisafe';

const dnsLookup = promisify(dns.lookup);

class SS3SimpliCam {

    constructor(name, id, cameraDetails, cameraOptions, log, debug, simplisafe, authManager, Service, Characteristic, UUIDGen, CameraController) {
        this.Characteristic = Characteristic;
        this.Service = Service;
        this.UUIDGen = UUIDGen;
        this.id = id;
        this.cameraDetails = cameraDetails;
        this.cameraOptions = cameraOptions;
        this.log = log;
        this.debug = debug;
        this.name = name;
        this.simplisafe = simplisafe;
        this.authManager = authManager;
        this.uuid = UUIDGen.generate(id);
        this.reachable = true;
        this.nSocketConnectFailures = 0;

        this.ffmpegPath = isDocker() ? 'ffmpeg' : ffmpegPath;
        if (this.debug && isDocker()) this.log('Detected running in docker, initializing with docker-bundled ffmpeg');
        if (this.cameraOptions && this.cameraOptions.ffmpegPath) {
            this.ffmpegPath = this.cameraOptions.ffmpegPath;
        }

        this.services = [];

        this.controller;
        this.pendingSessions = {};
        this.ongoingSessions = {};

        let fps = this.cameraDetails.cameraSettings.admin.fps;
        let streamingOptions = {
            proxy: false,
            srtp: true,
            video: {
                resolutions: [
                    [320, 240, fps],
                    [320, 240, 15],
                    [320, 180, fps],
                    [320, 180, 15],
                    [480, 360, fps],
                    [480, 270, fps],
                    [640, 480, fps],
                    [640, 360, fps],
                    [1280, 720, fps],
                    [1920, 1080, fps]
                ],
                codec: {
                    profiles: [0, 1, 2],
                    levels: [0, 1, 2]
                }
            },
            audio: {
                codecs: [
                    {
                        type: 'AAC-eld',
                        samplerate: 16
                    }
                ]
            }
        };

        let resolution = this.cameraDetails.cameraSettings.pictureQuality;
        let maxSupportedHeight = +(resolution.split('p')[0]);
        streamingOptions.video.resolutions = streamingOptions.video.resolutions.filter(r => r[1] <= maxSupportedHeight);

        const cameraController = new CameraController({
            cameraStreamCount: 2,
            delegate: this,
            streamingOptions: streamingOptions
        });

        this.controller = cameraController;

        this.startListening();
    }

    identify(callback) {
        if (this.debug) this.log(`Identify request for ${this.name}`);
        callback();
    }

    setAccessory(accessory) {
        this.accessory = accessory;
        this.accessory.on('identify', (paired, callback) => this.identify(callback));

        this.accessory.getService(this.Service.AccessoryInformation)
            .setCharacteristic(this.Characteristic.Manufacturer, 'SimpliSafe')
            .setCharacteristic(this.Characteristic.Model, this.cameraDetails.model)
            .setCharacteristic(this.Characteristic.SerialNumber, this.id)
            .setCharacteristic(this.Characteristic.FirmwareRevision, this.cameraDetails.cameraSettings.admin.firmwareVersion);

        let motionSensor = this.accessory.getService(this.Service.MotionSensor)
            .getCharacteristic(this.Characteristic.MotionDetected)
            .on('get', callback => this.getState(callback, this.accessory.getService(this.Service.MotionSensor), this.Characteristic.MotionDetected));
        this.services.push(motionSensor);

        if (this.accessory.getService(this.Service.Doorbell)) {
            let doorbell = this.accessory.getService(this.Service.Doorbell)
                .getCharacteristic(this.Characteristic.ProgrammableSwitchEvent)
                .on('get', callback => this.getState(callback, this.accessory.getService(this.Service.Doorbell), this.Characteristic.ProgrammableSwitchEvent));
            this.services.push(doorbell);
        }

        this.accessory.configureController(this.controller);
    }

    getState(callback, service, characteristicType) {
        if (this.simplisafe.isBlocked && Date.now() < this.simplisafe.nextAttempt) {
            callback(new Error('Request blocked (rate limited)'));
            return;
        }
        let characteristic = service.getCharacteristic(characteristicType);
        callback(null, characteristic.value);
    }

    async updateReachability() {
        try {
            let cameras = await this.simplisafe.getCameras();
            let camera = cameras.find(cam => cam.uuid === this.id);
            if (!camera) {
                this.reachable = false;
            } else {
                this.reachable = camera.status == 'online';
            }

            return this.reachable;
        } catch (err) {
            this.log.error(`An error occurred while updating reachability for ${this.name}`);
            this.log.error(err);
        }
    }

    async startListening() {
        if (this.debug && this.simplisafe.isSocketConnected()) this.log(`${this.name} camera now listening for real time events.`);
        try {
            await this.simplisafe.subscribeToEvents((event, data) => {
                switch (event) {
                    // Socket events
                    case EVENT_TYPES.CONNECTED:
                        if (this.debug) this.log(`${this.name} camera now listening for real time events.`);
                        this.nSocketConnectFailures = 0;
                        break;
                    case EVENT_TYPES.DISCONNECT:
                        if (this.debug) this.log(`${this.name} camera real time events disconnected.`);
                        break;
                    case EVENT_TYPES.CONNECTION_LOST:
                        if (this.debug && this.nSocketConnectFailures == 0) this.log(`${this.name} camera real time events connection lost. Attempting to reconnect...`);
                        setTimeout(async () => {
                            await this.startListening();
                        }, SOCKET_RETRY_INTERVAL);
                        break;
                }

                if (this.accessory && data) {
                    let eventCameraIds = [data.sensorSerial];
                    if (data.internal) eventCameraIds.push(data.internal.mainCamera);

                    if (eventCameraIds.indexOf(this.id) > -1) {
                        // Camera events
                        if (this.debug) this.log(`${this.name} camera received event: ${event}`);
                        switch (event) {
                            case EVENT_TYPES.CAMERA_MOTION:
                                this.accessory.getService(this.Service.MotionSensor).updateCharacteristic(this.Characteristic.MotionDetected, true);
                                this.motionIsTriggered = true;
                                setTimeout(() => {
                                    this.accessory.getService(this.Service.MotionSensor).updateCharacteristic(this.Characteristic.MotionDetected, false);
                                    this.motionIsTriggered = false;
                                }, 5000);
                                break;
                            case EVENT_TYPES.DOORBELL:
                                this.accessory.getService(this.Service.Doorbell).getCharacteristic(this.Characteristic.ProgrammableSwitchEvent).setValue(0);
                                break;
                            default:
                                if (this.debug) this.log(`${this.name} camera ignoring unhandled event: ${event}`);
                                break;
                        }
                    }
                }
            });
        } catch (err) {
            if (err instanceof RateLimitError) {
                let retryInterval = (2 ** this.nSocketConnectFailures) * SOCKET_RETRY_INTERVAL;
                if (this.debug) this.log(`${this.name} camera caught RateLimitError, waiting ${retryInterval/1000}s to retry...`);
                setTimeout(async () => {
                    await this.startListening();
                }, retryInterval);
                this.nSocketConnectFailures++;
            }
        }
    }

    async handleSnapshotRequest(request, callback) {
        if (this.simplisafe.isBlocked && Date.now() < this.simplisafe.nextAttempt) {
            callback(new Error('Camera snapshot request blocked (rate limited)'));
            return;
        }

        let resolution = `${request.width}x${request.height}`;
        if (this.debug) this.log(`Handling camera snapshot for '${this.cameraDetails.cameraSettings.cameraName}' at ${resolution}`);

        if (!this.motionIsTriggered && this.cameraDetails.model == 'SS001') { // Model(s) with privacy shutter
            // Because if privacy shutter is closed we dont want snapshots triggering it to open
            let alarmState = await this.simplisafe.getAlarmState();
            switch (alarmState) {
                case 'OFF':
                    if (this.cameraDetails.cameraSettings.shutterOff !== 'open') {
                        if (this.debug) this.log(`Camera snapshot request ignored, '${this.cameraDetails.cameraSettings.cameraName}' privacy shutter closed`);
                        callback(new Error('Privacy shutter closed'));
                        return;
                    }
                    break;

                case 'HOME':
                    if (this.cameraDetails.cameraSettings.shutterHome !== 'open') {
                        if (this.debug) this.log(`Camera snapshot request ignored, '${this.cameraDetails.cameraSettings.cameraName}' privacy shutter closed`);
                        callback(new Error('Privacy shutter closed'));
                        return;
                    }
                    break;

                case 'AWAY':
                    if (this.cameraDetails.cameraSettings.shutterAway !== 'open') {
                        if (this.debug) this.log(`Camera snapshot request ignored, '${this.cameraDetails.cameraSettings.cameraName}' privacy shutter closed`);
                        callback(new Error('Privacy shutter closed'));
                        return;
                    }
                    break;
            }
        }

        try {
            let newIpAddress = await dnsLookup('media.simplisafe.com');
            this.serverIpAddress = newIpAddress.address;
        } catch (err) {
            if (!this.serverIpAddress) {
                this.log.error('Could not resolve hostname for media.simplisafe.com');
            }
        }

        const url = {
            url: `https://${this.serverIpAddress}/v1/${this.cameraDetails.uuid}/mjpg?x=${request.width}&fr=1`,
            headers: {
                'Authorization': `Bearer ${this.authManager.accessToken}`
            },
            rejectUnauthorized: false // OK because we are using IP and just polled DNS
        };

        jpegExtract(url).then(img => {
            if (this.debug) this.log(`Closed '${this.cameraDetails.cameraSettings.cameraName}' snapshot request with ${Math.round(img.length/1000)}kB image`);
            callback(undefined, img);
        }).catch(err => {
            this.log.error('An error occurred while making snapshot request:', err.statusCode ? err.statusCode : '', err.statusMessage ? err.statusMessage : '');
            if (this.debug) this.log.error(err);
            callback(err);
        });
    }

    prepareStream(request, callback) {
        if (this.debug) this.log('Prepare stream with request:', request);
        let response = {};
        let sessionInfo = {
            address: request.targetAddress
        };

        let sessionID = request.sessionID;

        if (request.video) {
            let ssrcSource = crypto.randomBytes(4);
            ssrcSource[0] = 0;
            let ssrc = ssrcSource.readInt32BE(0, true);

            response.video = {
                port: request.video.port,
                ssrc: ssrc,
                srtp_key: request.video.srtp_key,
                srtp_salt: request.video.srtp_salt
            };

            sessionInfo.video_port = request.video.port;
            sessionInfo.video_srtp = Buffer.concat([
                request.video.srtp_key,
                request.video.srtp_salt
            ]);
            sessionInfo.video_ssrc = ssrc;
        }

        if (request.audio) {
            let ssrcSource = crypto.randomBytes(4);
            ssrcSource[0] = 0;
            let ssrc = ssrcSource.readInt32BE(0, true);

            response.audio = {
                port: request.audio.port,
                ssrc: ssrc,
                srtp_key: request.audio.srtp_key,
                srtp_salt: request.audio.srtp_salt
            };

            sessionInfo.audio_port = request.audio.port;
            sessionInfo.audio_srtp = Buffer.concat([
                request.audio.srtp_key,
                request.audio.srtp_salt
            ]);
            sessionInfo.audio_ssrc = ssrc;
        }

        let myIPAddress = ip.address();
        response.address = {
            address: myIPAddress,
            type: ip.isV4Format(myIPAddress) ? 'v4' : 'v6'
        };

        this.pendingSessions[this.UUIDGen.unparse(sessionID)] = sessionInfo;

        callback(undefined, response);
    }

    async handleStreamRequest(request, callback) {
        if (this.debug) this.log('handleStreamRequest with request:', request);
        let sessionId = request.sessionID;
        if (sessionId) {
            let sessionIdentifier = this.UUIDGen.unparse(sessionId);

            if (request.type == 'start') {

                if (this.simplisafe.isBlocked && Date.now() < this.simplisafe.nextAttempt) {
                    delete this.pendingSessions[sessionIdentifier];
                    let err = new Error('Camera stream request blocked (rate limited)');
                    this.log.error(err);
                    callback(err);
                    return;
                }

                let sessionInfo = this.pendingSessions[sessionIdentifier];
                if (sessionInfo) {
                    let width = request.video.width ?? 1920;
                    let fps = this.cameraDetails.cameraSettings.admin.fps;
                    let videoBitrate = this.cameraDetails.cameraSettings.admin.bitRate;
                    let audioBitrate = request.audio.max_bit_rate ?? 96;
                    let audioSamplerate = request.audio.sample_rate ?? 16;
                    let mtu = request.video.mtu ?? 1316;

                    if (request.video.fps < fps) {
                        fps = request.video.fps;
                    }
                    if (request.video.max_bit_rate < videoBitrate) {
                        videoBitrate = request.video.max_bit_rate;
                    }

                    try {
                        let newIpAddress = await dnsLookup('media.simplisafe.com');
                        this.serverIpAddress = newIpAddress.address;
                    } catch (err) {
                        if (!this.serverIpAddress) {
                            delete this.pendingSessions[sessionIdentifier];
                            this.log.error('Camera stream request failed, could not resolve hostname for media.simplisafe.com', err);
                            callback(err);
                            return;
                        }
                    }

                    let sourceArgs = [
                        ['-re'],
                        ['-headers', `Authorization: Bearer ${this.authManager.accessToken}`],
                        ['-i', `https://${this.serverIpAddress}/v1/${this.cameraDetails.uuid}/flv?x=${width}&audioEncoding=AAC`]
                    ];

                    let videoArgs = [
                        ['-map', '0:0'],
                        ['-vcodec', 'libx264'],
                        ['-tune', 'zerolatency'],
                        ['-preset', 'superfast'],
                        ['-pix_fmt', 'yuv420p'],
                        ['-r', fps],
                        ['-f', 'rawvideo'],
                        ['-vf', `scale=${width}:-2`],
                        ['-b:v', `${videoBitrate}k`],
                        ['-bufsize', `${2*videoBitrate}k`],
                        ['-maxrate', `${videoBitrate}k`],
                        ['-payload_type', 99],
                        ['-ssrc', sessionInfo.video_ssrc],
                        ['-f', 'rtp'],
                        ['-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80'],
                        ['-srtp_out_params', sessionInfo.video_srtp.toString('base64')],
                        [`srtp://${sessionInfo.address}:${sessionInfo.video_port}?rtcpport=${sessionInfo.video_port}&localrtcpport=${sessionInfo.video_port}&pkt_size=${mtu}`]
                    ];

                    let audioArgs = [
                        ['-map', '0:1'],
                        ['-acodec', 'libfdk_aac'],
                        ['-flags', '+global_header'],
                        ['-profile:a', 'aac_eld'],
                        ['-ac', '1'],
                        ['-ar', `${audioSamplerate}k`],
                        ['-b:a', `${audioBitrate}k`],
                        ['-bufsize', `${2*audioBitrate}k`],
                        ['-payload_type', 110],
                        ['-ssrc', sessionInfo.audio_ssrc],
                        ['-f', 'rtp'],
                        ['-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80'],
                        ['-srtp_out_params', sessionInfo.audio_srtp.toString('base64')],
                        [`srtp://${sessionInfo.address}:${sessionInfo.audio_port}?rtcpport=${sessionInfo.audio_port}&localrtcpport=${sessionInfo.audio_port}&pkt_size=188`]
                    ];

                    if (isDocker() && (!this.cameraOptions || !this.cameraOptions.ffmpegPath)) { // if docker and no custom binary specified
                        if (this.debug) this.log('Detected running in docker container with bundled binary, limiting to 720px wide');
                        width = Math.min(width, 720);
                        let vFilterArg = videoArgs.find(arg => arg[0] == '-vf');
                        vFilterArg[1] = `scale=${width}:-2`;
                    }

                    if (request.audio && request.audio.codec == 'OPUS') {
                        // Request is for OPUS codec, serve that
                        let iArg = sourceArgs.find(arg => arg[0] == '-i');
                        iArg[1] = iArg[1].replace('&audioEncoding=AAC', '');
                        let aCodecArg = audioArgs.find(arg => arg[0] == '-acodec');
                        aCodecArg[1] = 'libopus';
                        let profileArg = audioArgs.find(arg => arg[0] == '-profile:a');
                        audioArgs.splice(audioArgs.indexOf(profileArg), 1);
                    }

                    if (this.cameraOptions) {
                        if (this.cameraOptions.enableHwaccelRpi) {
                            let iArg = sourceArgs.find(arg => arg[0] == '-i');
                            sourceArgs.splice(sourceArgs.indexOf(iArg), 0, ['-vcodec', 'h264_mmal']);
                            let vCodecArg = videoArgs.find(arg => arg[0] == '-vcodec');
                            vCodecArg[1] = 'h264_omx';
                            videoArgs = videoArgs.filter(arg => arg[0] !== '-tune');
                            videoArgs = videoArgs.filter(arg => arg[0] !== '-preset');
                        }

                        if (this.cameraOptions.sourceOptions) {
                            let options = (typeof this.cameraOptions.sourceOptions === 'string') ? Object.fromEntries(this.cameraOptions.sourceOptions.split('-').filter(x => x).map(arg => '-' + arg).map(a => a.split(' ').filter(x => x)))
                                : this.cameraOptions.sourceOptions; // support old config schema
                            for (let key in options) {
                                let value = options[key];
                                let existingArg = sourceArgs.find(arg => arg[0] === key);
                                if (existingArg) {
                                    if (value === false) {
                                        sourceArgs = sourceArgs.filter(arg => arg[0] !== key);
                                    } else {
                                        existingArg[1] = options[key];
                                    }
                                } else {
                                    sourceArgs.unshift([key, options[key]]);
                                }
                            }
                        }

                        if (this.cameraOptions.videoOptions) {
                            let options = (typeof this.cameraOptions.videoOptions === 'string') ? Object.fromEntries(this.cameraOptions.videoOptions.split('-').filter(x => x).map(arg => '-' + arg).map(a => a.split(' ').filter(x => x)))
                                : this.cameraOptions.videoOptions; // support old config schema
                            for (let key in options) {
                                let value = options[key];
                                let existingArg = videoArgs.find(arg => arg[0] === key);
                                if (existingArg) {
                                    if (value === false) {
                                        videoArgs = videoArgs.filter(arg => arg[0] !== key);
                                    } else {
                                        existingArg[1] = options[key];
                                    }
                                } else {
                                    videoArgs.push([key, options[key]]);
                                }
                            }
                        }

                        if (this.cameraOptions.audioOptions) {
                            let options = (typeof this.cameraOptions.audioOptions === 'string') ? Object.fromEntries(this.cameraOptions.audioOptions.split('-').filter(x => x).map(arg => '-' + arg).map(a => a.split(' ').filter(x => x)))
                                : this.cameraOptions.audioOptions; // support old config schema
                            for (let key in options) {
                                let value = options[key];
                                let existingArg = audioArgs.find(arg => arg[0] === key);
                                if (existingArg) {
                                    if (value === false) {
                                        audioArgs = audioArgs.filter(arg => arg[0] !== key);
                                    } else {
                                        existingArg[1] = options[key];
                                    }
                                } else {
                                    audioArgs.push([key, options[key]]);
                                }
                            }
                        }
                    }

                    let source = [].concat(...sourceArgs.map(arg => arg.map(a => typeof a == 'string' ? a.trim() : a)));
                    let video = [].concat(...videoArgs.map(arg => arg.map(a => typeof a == 'string' ? a.trim() : a)));
                    let audio = [].concat(...audioArgs.map(arg => arg.map(a => typeof a == 'string' ? a.trim() : a)));

                    let cmd = spawn(this.ffmpegPath, [
                        ...source,
                        ...video,
                        ...audio
                    ], {
                        env: process.env
                    });

                    if (this.debug) {
                        this.log(`Start streaming video for camera '${this.cameraDetails.cameraSettings.cameraName}'`);
                        this.log([this.ffmpegPath, source.join(' '), video.join(' '), audio.join(' ')].join(' '));
                    }

                    let started = false;
                    cmd.stderr.on('data', data => {
                        if (!started) {
                            started = true;
                            if (this.debug) this.log('FFMPEG received first frame');
                            callback(); // do not forget to execute callback once set up
                        }
                        if (this.debug) {
                            this.log(data.toString());
                        }
                    });

                    cmd.on('error', err => {
                        this.log.error('An error occurred while making stream request:', err);
                        callback(err);
                    });

                    cmd.on('close', code => {
                        switch (code) {
                            case null:
                            case 0:
                            case 255:
                                if (this.debug) this.log('Camera stopped streaming');
                                break;
                            default:
                                if (this.debug) this.log(`Error: FFmpeg exited with code ${code}`);
                                if (!started) {
                                    callback(new Error(`Error: FFmpeg exited with code ${code}`));
                                } else {
                                    this.controller.forceStopStreamingSession(sessionId);
                                }
                                break;
                        }
                    });

                    this.ongoingSessions[sessionIdentifier] = cmd;
                }

                delete this.pendingSessions[sessionIdentifier];

            } else if (request.type == 'stop') {
                let cmd = this.ongoingSessions[sessionIdentifier];
                try {
                    if (cmd) {
                        cmd.kill('SIGKILL');
                    }
                } catch (e) {
                    this.log.error('Error occurred terminating the video process!');
                    if (this.debug) this.log.error(e);
                }

                delete this.ongoingSessions[sessionIdentifier];
                callback();
            }
        }
    }
}

export default SS3SimpliCam;
