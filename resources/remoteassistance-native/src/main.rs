use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use ironrdp_connector::{ClientConnector, Config, ConnectionResult, Credentials, DesktopSize};
use ironrdp_core::{impl_as_any, Encode, EncodeResult, WriteCursor};
use ironrdp_dvc::{DrdynvcClient, DvcMessage, DvcProcessor};

use ironrdp_egfx::pdu::{
    CapabilitiesAdvertisePdu, CapabilitiesV104Flags, CapabilitiesV81Flags, CapabilitiesV8Flags,
    CapabilitySet, GfxPdu,
};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_graphics::zgfx::{wrap_uncompressed, Decompressor as ZgfxDecompressor};
use ironrdp_pdu::gcc::{ChannelName, KeyboardType};
use ironrdp_pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp_pdu::rdp::client_info::{CompressionType, PerformanceFlags, TimezoneInfo};
use ironrdp_pdu::PduResult;
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStageBuilder, ActiveStageOutput};
use ironrdp_svc::{
    CompressionCondition, StaticChannelSet, SvcClientProcessor, SvcMessage, SvcProcessor,
};
use sspi::network_client::reqwest_network_client::ReqwestNetworkClient;
use tokio_rustls::rustls;
use x509_cert::der::Decode;

type Trace = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

macro_rules! channel_processor {
    ($type:ident, $name:literal) => {
        #[derive(Debug, Clone)]
        struct $type {
            trace: Arc<Mutex<Vec<(String, Vec<u8>)>>>,
        }
        impl_as_any!($type);
        impl SvcProcessor for $type {
            fn channel_name(&self) -> ChannelName {
                ChannelName::from_utf8($name).expect("valid RDP channel name")
            }
            fn compression_condition(&self) -> CompressionCondition {
                CompressionCondition::Never
            }
            fn process(&mut self, payload: &[u8]) -> PduResult<Vec<SvcMessage>> {
                if let Ok(mut trace) = self.trace.lock() {
                    if trace.len() < 16 {
                        trace.push(($name.to_owned(), payload.to_vec()));
                    }
                }
                Ok(Vec::new())
            }
        }
        impl SvcClientProcessor for $type {}
    };
}

channel_processor!(RemoteAssistanceChat, "70");
channel_processor!(RemoteAssistanceShare, "71");
channel_processor!(RemoteAssistanceMultiparty, "encomsp");

/// The control channel, under both names it is known by.
///
/// [MS-RA] section 3.5.3 says a channel named `RC_CTL` must be opened before
/// any control message can be exchanged. FreeRDP names it `remdesk` instead,
/// and that is the name this client used while the novice stayed silent — a
/// server grants whatever channel a client asks for, so the mistake is not
/// visible in the channel list. Both are registered until a live session says
/// which one the novice actually speaks on.
macro_rules! control_processor {
    ($type:ident, $name:literal) => {
        #[derive(Debug, Clone)]
        struct $type {
            trace: Trace,
            expert_name: String,
            expert_on_vista_sent: bool,
            verify_password_sent: bool,
        }

        impl $type {
            fn new(trace: Trace, expert_name: String) -> Self {
                Self {
                    trace,
                    expert_name,
                    expert_on_vista_sent: false,
                    verify_password_sent: false,
                }
            }
        }

        impl_as_any!($type);

        impl SvcProcessor for $type {
            fn channel_name(&self) -> ChannelName {
                ChannelName::from_utf8($name).expect("valid RDP channel name")
            }

            fn compression_condition(&self) -> CompressionCondition {
                CompressionCondition::Never
            }

            fn process(&mut self, payload: &[u8]) -> PduResult<Vec<SvcMessage>> {
                Ok(process_remote_assistance_control(
                    $name,
                    payload,
                    &self.trace,
                    &self.expert_name,
                    &mut self.expert_on_vista_sent,
                    &mut self.verify_password_sent,
                ))
            }
        }

        impl SvcClientProcessor for $type {}
    };
}

control_processor!(RemoteAssistanceControl, "RC_CTL");
control_processor!(RemoteAssistanceControlRemdesk, "remdesk");

fn process_remote_assistance_control(
    channel: &str,
    payload: &[u8],
    trace: &Trace,
    expert_name: &str,
    expert_on_vista_sent: &mut bool,
    verify_password_sent: &mut bool,
) -> Vec<SvcMessage> {
    eprintln!(
        "svc {channel} data bytes={} prefix={}",
        payload.len(),
        hex_prefix(payload)
    );
    if let Ok(mut trace) = trace.lock() {
        if trace.len() < 16 {
            trace.push((channel.to_owned(), payload.to_vec()));
        }
    }

    let Some((message_type, body)) = parse_remote_assistance_packet(payload) else {
        eprintln!("svc {channel} data is not a valid Remote Assistance packet");
        return Vec::new();
    };
    eprintln!(
        "svc {channel} RC_CTL msgType={} ({}) bodyBytes={}",
        message_type,
        remote_assistance_message_name(message_type),
        body.len()
    );

    remote_assistance_control_responses(
        message_type,
        body,
        expert_name,
        expert_on_vista_sent,
        verify_password_sent,
    )
    .into_iter()
    .map(SvcMessage::from)
    .collect()
}

#[derive(Debug, Clone)]
struct RdpEchoDynamic {
    trace: Trace,
}

#[derive(Debug, Clone)]
struct EchoResponse {
    payload: Vec<u8>,
}

impl Encode for EchoResponse {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        dst.write_slice(&self.payload);
        Ok(())
    }

    fn name(&self) -> &'static str {
        "ECHO_RESPONSE_PDU"
    }
    fn size(&self) -> usize {
        self.payload.len()
    }
}

impl ironrdp_dvc::DvcEncode for EchoResponse {}

impl_as_any!(RdpEchoDynamic);

impl DvcProcessor for RdpEchoDynamic {
    fn channel_name(&self) -> &str {
        "ECHO"
    }

    fn start(&mut self, channel_id: u32) -> PduResult<Vec<DvcMessage>> {
        eprintln!("dvc channel opened name=ECHO id={channel_id}");
        Ok(Vec::new())
    }

    fn process(&mut self, channel_id: u32, payload: &[u8]) -> PduResult<Vec<DvcMessage>> {
        eprintln!(
            "dvc ECHO data id={channel_id} bytes={} prefix={}",
            payload.len(),
            hex_prefix(payload)
        );
        if let Ok(mut trace) = self.trace.lock() {
            if trace.len() < 16 {
                trace.push(("ECHO".to_owned(), payload.to_vec()));
            }
        }
        Ok(vec![Box::new(EchoResponse {
            payload: payload.to_vec(),
        })])
    }
}

/// Raw bytes already framed for a dynamic channel.
#[derive(Debug, Clone)]
struct RawDvcMessage {
    name: &'static str,
    bytes: Vec<u8>,
}

impl Encode for RawDvcMessage {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        dst.write_slice(&self.bytes);
        Ok(())
    }
    fn name(&self) -> &'static str {
        self.name
    }
    fn size(&self) -> usize {
        self.bytes.len()
    }
}

impl ironrdp_dvc::DvcEncode for RawDvcMessage {}

/// The graphics channel, with the segment wrapping the server expects.
///
/// `ironrdp-egfx` 0.3.0 wraps outgoing PDUs on its server side — "Windows
/// clients expect this wrapping on the EGFX DVC" — but its client side sends
/// them bare. A Windows server expects it just the same, so the capability
/// advertise this client sent could not be read, and the session was dropped
/// the moment it arrived. Everything outgoing goes through `wrap_uncompressed`
/// here for that reason.
struct GraphicsPipelineDvc {
    decompressor: ZgfxDecompressor,
    buffer: Vec<u8>,
    pdus: usize,
    claim_avc: bool,
}

impl GraphicsPipelineDvc {
    fn new(claim_avc: bool) -> Self {
        Self {
            decompressor: ZgfxDecompressor::new(),
            buffer: Vec::new(),
            pdus: 0,
            claim_avc,
        }
    }
}

impl_as_any!(GraphicsPipelineDvc);

impl DvcProcessor for GraphicsPipelineDvc {
    fn channel_name(&self) -> &str {
        ironrdp_egfx::CHANNEL_NAME
    }

    fn start(&mut self, channel_id: u32) -> PduResult<Vec<DvcMessage>> {
        // The listener runs version 10.6 — the client-side RDP log records
        // 0xA0600 — so offer that, and older versions behind it.
        //
        // AVC is declared off, honestly, because there is no H.264 decoder here.
        // Whether a listener that can only encode AVC will hold a session open
        // for a client that refuses it is still unanswered: the target grew too
        // erratic to measure it, creating the graphics channel on some runs and
        // not others with the same bytes on the wire. `--claim-avc` says it is
        // supported so the question can be settled in one command.
        let mut flags = CapabilitiesV104Flags::SMALL_CACHE;
        if !self.claim_avc {
            flags |= CapabilitiesV104Flags::AVC_DISABLED;
        }
        let caps = [
            CapabilitySet::V10_6 { flags },
            CapabilitySet::V8_1 {
                flags: CapabilitiesV81Flags::SMALL_CACHE,
            },
            CapabilitySet::V8 {
                flags: CapabilitiesV8Flags::SMALL_CACHE,
            },
        ];
        let pdu = GfxPdu::CapabilitiesAdvertise(CapabilitiesAdvertisePdu::from_typed(&caps));
        let mut bytes = vec![0u8; pdu.size()];
        pdu.encode(&mut WriteCursor::new(&mut bytes))
            .map_err(|error| ironrdp_pdu::encode_err!(error))?;

        eprintln!(
            "egfx channel opened id={channel_id}; advertising 10.6, 8.1 and 8 in a ZGFX segment"
        );
        Ok(vec![Box::new(RawDvcMessage {
            name: "RDPGFX_CAPS_ADVERTISE_PDU",
            bytes: wrap_uncompressed(&bytes),
        })])
    }

    fn process(&mut self, _channel_id: u32, payload: &[u8]) -> PduResult<Vec<DvcMessage>> {
        self.buffer.clear();
        if let Err(error) = self.decompressor.decompress(payload, &mut self.buffer) {
            eprintln!("egfx payload could not be decompressed: {error}");
            return Ok(Vec::new());
        }
        self.pdus += 1;
        eprintln!(
            "egfx payload {} decompressed to {} bytes, prefix={}",
            self.pdus,
            self.buffer.len(),
            hex_prefix(&self.buffer)
        );
        Ok(Vec::new())
    }
}


fn main() -> io::Result<()> {
    // host, port and the expert's name. The account's password is deliberately
    // not taken: Remote Assistance requires "*" in the Client Info PDU password
    // field, so the helper has no use for the real one.
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 4 {
        let invitation = read_invitation_argument(&args).map_err(|error| {
            eprintln!("remote assistance invitation error: {error:#}");
            io::Error::new(io::ErrorKind::InvalidInput, error.to_string())
        })?;
        let result = if args.iter().any(|arg| arg == "--tls-probe") {
            connect_direct_tls(&args[1], args[2].parse().unwrap_or(51878))
                .map(|trace| format!("remote assistance TLS connected\n{}", trace))
        } else {
            // The password never travels on the command line, where it would be
            // visible in the process list for as long as the client runs.
            let logon_password = args
                .iter()
                .any(|arg| arg == "--logon")
                .then(|| std::env::var("TD_PW").unwrap_or_default());
            connect_once(
                &args[1],
                args[2].parse().unwrap_or(3389),
                &args[3],
                invitation.as_deref(),
                logon_password.as_deref(),
                args.iter().any(|arg| arg == "--bare-info"),
                args.iter().any(|arg| arg == "--claim-avc"),
            )
            .map(|(user_channel_id, trace)| {
                format!(
                    "rdp connected; remdesk channel negotiated; user-channel={user_channel_id}\n{}",
                    trace_lines(&trace)
                )
            })
        };
        match result {
            Ok(message) => {
                println!("{message}");
            }
            Err(error) => eprintln!("remote assistance connection failed: {error:#}"),
        }
    } else {
        let mut input = String::new();
        io::stdin().read_to_string(&mut input)?;
        println!("remdesk channel registered; input-bytes={}", input.len());
    }
    Ok(())
}

fn trace_lines(trace: &Trace) -> String {
    trace
        .lock()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, (name, packet))| {
            format!(
                "channel={name} packet={} bytes={} prefix={}",
                index + 1,
                packet.len(),
                hex_prefix(packet)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn read_invitation_argument(args: &[String]) -> Result<Option<String>> {
    let Some(index) = args.iter().position(|arg| arg == "--invitation-file") else {
        return Ok(None);
    };
    let path = args
        .get(index + 1)
        .context("--invitation-file requires a path")?;
    let invitation = std::fs::read_to_string(Path::new(path))
        .with_context(|| format!("read Remote Assistance invitation file {path}"))?;
    if !invitation.contains("<E>") || !invitation.contains("</E>") {
        anyhow::bail!("invitation file does not contain an <E>...</E> XML document");
    }
    Ok(Some(invitation))
}

/// The `ID` of the Auth String Node — `<A ... ID="..."/>` — of a Remote
/// Assistance Connection String 2.
///
/// Read from that element specifically rather than from the document: the
/// transport node further down carries `SID`, which ends in the same letters and
/// would answer a plain search for the attribute.
fn auth_string_id(invitation: &str) -> Option<String> {
    let start = invitation.find("<A")?;
    let element = &invitation[start..start + invitation[start..].find('>')?];

    let mut rest = element;
    while let Some(at) = rest.find("ID=\"") {
        let starts_attribute = rest[..at]
            .chars()
            .last()
            .map_or(false, |character| character.is_ascii_whitespace());
        let value = &rest[at + "ID=\"".len()..];
        let close = value.find('"')?;
        if starts_attribute {
            return Some(value[..close].to_owned());
        }
        rest = &value[close + 1..];
    }
    None
}

fn parse_remote_assistance_packet(payload: &[u8]) -> Option<(u32, &[u8])> {
    if payload.len() < 12 {
        return None;
    }
    let channel_name_len = u32::from_le_bytes(payload[0..4].try_into().ok()?) as usize;
    let data_len = u32::from_le_bytes(payload[4..8].try_into().ok()?) as usize;
    if channel_name_len == 0 || channel_name_len > 64 || channel_name_len % 2 != 0 {
        return None;
    }
    let channel_end = 8usize.checked_add(channel_name_len)?;
    let data_end = channel_end.checked_add(data_len)?;
    if data_len < 4 || data_end > payload.len() {
        return None;
    }
    let channel_name = String::from_utf16(
        &payload[8..channel_end]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>(),
    )
    .ok()?;
    if channel_name.trim_end_matches('\0') != "RC_CTL" {
        return None;
    }
    let message_type = u32::from_le_bytes(payload[channel_end..channel_end + 4].try_into().ok()?);
    Some((message_type, &payload[channel_end + 4..data_end]))
}

/// The expert's side of the control exchange, as [MS-RA] section 3.5.5 sets it
/// out: the novice speaks first, and each of its two opening messages draws a
/// different reply.
///
/// > As soon as the basic Remote Assistance Connection is established, the
/// > expert receives the REMOTEDESKTOP_CTL_SERVER_ANNOUNCE and
/// > REMOTEDESKTOP_CTL_VERSIONINFO packets. The expert drops the
/// > REMOTEDESKTOP_CTL_VERSIONINFO packet and announces to the novice to use the
/// > version 2 protocol by sending the REMOTEDESKTOP_EXPERT_ON_VISTA packet. The
/// > expert also responds to the REMOTEDESKTOP_CTL_SERVER_ANNOUNCE packet by
/// > sending the REMOTEDESKTOP_CTL_VERIFY_PASSWORD packet.
fn remote_assistance_control_responses(
    message_type: u32,
    body: &[u8],
    expert_name: &str,
    expert_on_vista_sent: &mut bool,
    verify_password_sent: &mut bool,
) -> Vec<Vec<u8>> {
    match message_type {
        // RESULT carries the novice's verdict on VERIFY_PASSWORD.
        2 => {
            match read_u32(body) {
                Some(0) => eprintln!("remote assistance RESULT: no error, shadowing starts"),
                Some(code) => eprintln!("remote assistance RESULT error 0x{code:08x}"),
                None => eprintln!("remote assistance RESULT is truncated"),
            }
            Vec::new()
        }
        4 if !*verify_password_sent => {
            *verify_password_sent = true;
            eprintln!("remote assistance sending VERIFY_PASSWORD");
            // A shadow invitation carries no PassStub, so the password segment
            // is counted but empty.
            vec![build_remote_assistance_packet(
                8,
                &utf16le_null_terminated(&expert_blob(expert_name, "")),
            )]
        }
        // The version the novice announces is dropped; sending EXPERT_ON_VISTA
        // is itself what selects version 2.
        6 if !*expert_on_vista_sent => {
            if let Some((major, minor)) = read_version(body) {
                eprintln!("remote assistance novice announced protocol {major}.{minor}");
            }
            *expert_on_vista_sent = true;
            eprintln!("remote assistance sending EXPERT_ON_VISTA");
            vec![build_remote_assistance_packet(9, &[])]
        }
        _ => Vec::new(),
    }
}

/// The blob the novice reads is two counted segments, `<count>;NAME=<expert>`
/// followed by `<count>;PASS=<password>`, where each count covers the
/// characters of the segment behind it. Dropping the password segment leaves
/// the novice parsing a blob that ends mid-record, so it is sent counted and
/// empty when a shadow invitation gives nothing to put in it.
fn expert_blob(expert_name: &str, password: &str) -> String {
    let name_length = "NAME=".len() + expert_name.encode_utf16().count();
    let password_length = "PASS=".len() + password.encode_utf16().count();
    format!("{name_length};NAME={expert_name}{password_length};PASS={password}")
}

fn read_u32(body: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes(body.get(0..4)?.try_into().ok()?))
}

fn read_version(body: &[u8]) -> Option<(u32, u32)> {
    Some((read_u32(body)?, read_u32(body.get(4..)?)?))
}

fn build_remote_assistance_packet(message_type: u32, body: &[u8]) -> Vec<u8> {
    let channel_name: Vec<u16> = "RC_CTL\0".encode_utf16().collect();
    let channel_name_bytes = channel_name.len() * 2;
    let data_len = 4 + body.len();
    let mut packet = Vec::with_capacity(8 + channel_name_bytes + data_len);
    packet.extend_from_slice(&(channel_name_bytes as u32).to_le_bytes());
    packet.extend_from_slice(&(data_len as u32).to_le_bytes());
    for character in channel_name {
        packet.extend_from_slice(&character.to_le_bytes());
    }
    packet.extend_from_slice(&message_type.to_le_bytes());
    packet.extend_from_slice(body);
    packet
}

fn utf16le_null_terminated(value: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity((value.encode_utf16().count() + 1) * 2);
    for character in value.encode_utf16() {
        bytes.extend_from_slice(&character.to_le_bytes());
    }
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes
}

fn remote_assistance_message_name(message_type: u32) -> &'static str {
    match message_type {
        1 => "REMOTE_CONTROL_DESKTOP",
        2 => "RESULT",
        3 => "AUTHENTICATE",
        4 => "SERVER_ANNOUNCE",
        5 => "DISCONNECT",
        6 => "VERSIONINFO",
        7 => "ISCONNECTED",
        8 => "VERIFY_PASSWORD",
        9 => "EXPERT_ON_VISTA",
        10 => "RANOVICE_NAME",
        11 => "RAEXPERT_NAME",
        12 => "TOKEN",
        _ => "UNKNOWN",
    }
}

fn connect_direct_tls(host: &str, port: u16) -> Result<String> {
    let address = (host, port)
        .to_socket_addrs()
        .context("resolve Remote Assistance TLS endpoint")?
        .next()
        .context("endpoint has no address")?;
    let stream = TcpStream::connect_timeout(&address, Duration::from_secs(15))?;
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    let (mut tls, _) = tls_upgrade(stream, host)?;
    let mut first = [0u8; 8192];
    let count = tls
        .read(&mut first)
        .context("read Remote Assistance TLS payload")?;
    if count == 0 {
        anyhow::bail!("Remote Assistance endpoint closed TLS connection without a payload");
    }
    Ok(format!(
        "tls-payload bytes={} prefix={} classification={}",
        count,
        hex_prefix(&first[..count]),
        classify_remote_assistance_payload(&first[..count]),
    ))
}

fn classify_remote_assistance_payload(payload: &[u8]) -> &'static str {
    if payload.len() >= 4 {
        let msg_type = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
        return match msg_type {
            4 => "RC_CTL SERVER_ANNOUNCE",
            6 => "RC_CTL VERSIONINFO",
            8 => "RC_CTL VERIFY_PASSWORD",
            9 => "RC_CTL EXPERT_ON_VISTA",
            2 => "RC_CTL RESULT",
            _ => "Remote Assistance control payload",
        };
    }
    "unknown payload"
}

fn connect_once(
    host: &str,
    port: u16,
    username: &str,
    invitation: Option<&str>,
    logon_password: Option<&str>,
    bare_info: bool,
    claim_avc: bool,
) -> Result<(u16, Trace)> {
    let address = (host, port)
        .to_socket_addrs()
        .context("resolve Remote Assistance endpoint")?
        .next()
        .context("endpoint has no address")?;
    let stream = TcpStream::connect_timeout(&address, Duration::from_secs(15))?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let local = stream.local_addr()?;
    let auth_string = invitation.and_then(auth_string_id);
    let info = match (logon_password, bare_info) {
        (Some(password), _) => {
            eprintln!("client info: ordinary RDP logon as {username}, no invitation used");
            ClientInfoFields::logon(password)
        }
        (None, true) => {
            eprintln!("client info: every Remote Assistance field left empty");
            ClientInfoFields::bare()
        }
        (None, false) => {
            match &auth_string {
                Some(id) => eprintln!(
                    "client info: Remote Assistance, invitation {} bytes, auth string id={id}",
                    invitation.map_or(0, str::len)
                ),
                None => eprintln!(
                    "remote assistance invitation has no auth string id: the novice has \
                     nothing to match this connection against and will drop it"
                ),
            }
            ClientInfoFields::remote_assistance(auth_string.as_deref().unwrap_or_default())
        }
    };

    let mut framed = ironrdp_blocking::Framed::new(BareNegotiation::new(stream, !info.credssp));
    let trace: Trace = Arc::new(Mutex::new(Vec::new()));
    let config = build_config(username, &info);
    let expert_name = username.rsplit('\\').next().unwrap_or(username).to_owned();
    let mut connector = ClientConnector::new(config, local)
        .with_static_channel(RemoteAssistanceControl::new(
            trace.clone(),
            expert_name.clone(),
        ))
        .with_static_channel(RemoteAssistanceControlRemdesk::new(
            trace.clone(),
            expert_name,
        ))
        .with_static_channel(
            DrdynvcClient::new()
                .with_dynamic_channel(RdpEchoDynamic {
                    trace: trace.clone(),
                })
                .with_dynamic_channel(GraphicsPipelineDvc::new(claim_avc)),
        )
        .with_static_channel(RemoteAssistanceChat {
            trace: trace.clone(),
        })
        .with_static_channel(RemoteAssistanceShare {
            trace: trace.clone(),
        })
        .with_static_channel(RemoteAssistanceMultiparty {
            trace: trace.clone(),
        });

    let upgrade = ironrdp_blocking::connect_begin(&mut framed, &mut connector)?;
    let stream = framed.into_inner_no_leftover().into_inner();
    let (tls_stream, public_key) = tls_upgrade(stream, host)?;
    let upgraded_connector = ironrdp_blocking::mark_as_upgraded(upgrade, &mut connector);
    let mut upgraded = ironrdp_blocking::Framed::new(GraphicsPipelineAnnounced::new(tls_stream));
    let mut network_client = ReqwestNetworkClient;
    let result = ironrdp_blocking::connect_finalize(
        upgraded_connector,
        connector,
        &mut upgraded,
        &mut network_client,
        host.to_owned().into(),
        public_key,
        None,
    )?;
    let user_channel_id = result.user_channel_id;
    if let Err(error) = run_active_stage(result, upgraded) {
        if let Ok(trace) = trace.lock() {
            for (index, (name, packet)) in trace.iter().enumerate() {
                eprintln!(
                    "channel={name} packet={} bytes={} prefix={}",
                    index + 1,
                    packet.len(),
                    hex_prefix(packet)
                );
            }
        }
        return Err(error);
    }
    Ok((user_channel_id, trace))
}

/// Reports which of the channels the client asked for the server actually
/// granted. A channel with no id was refused, and nothing sent on it can
/// arrive — which is the first thing to rule out when a novice stays silent.
fn log_granted_channels(channels: &StaticChannelSet) {
    for (type_id, channel) in channels.iter() {
        match channels.get_channel_id_by_type_id(type_id) {
            Some(id) => eprintln!("static channel {:?} granted id={id}", channel.channel_name()),
            None => eprintln!("static channel {:?} was refused", channel.channel_name()),
        }
    }
}

fn run_active_stage(
    result: ConnectionResult,
    mut framed: ironrdp_blocking::Framed<GraphicsPipelineAnnounced>,
) -> Result<()> {
    // The handshake has to fail rather than hang, but an active session that
    // nobody is touching legitimately sends nothing for minutes. Keeping the
    // handshake's timeout here makes the client hang up on an idle desktop.
    if let Err(error) = framed.get_inner_mut().0.socket().set_read_timeout(None) {
        eprintln!("could not clear the read timeout for the active session: {error}");
    }

    log_granted_channels(&result.static_channels);
    eprintln!(
        "session active: desktop {}x{} share-id={} compression={:?} server-pointer={}",
        result.desktop_size.width,
        result.desktop_size.height,
        result.share_id,
        result.compression_type,
        result.enable_server_pointer
    );
    let mut stage = ActiveStageBuilder {
        static_channels: result.static_channels,
        user_channel_id: result.user_channel_id,
        io_channel_id: result.io_channel_id,
        message_channel_id: result.message_channel_id,
        share_id: result.share_id,
        compression_type: result.compression_type,
        enable_server_pointer: result.enable_server_pointer,
        pointer_software_rendering: result.pointer_software_rendering,
    }
    .build();
    let mut image = DecodedImage::new(
        PixelFormat::RgbA32,
        result.desktop_size.width,
        result.desktop_size.height,
    );

    // Whether the server rejects this client or waits for something it never
    // sends looks identical in a log without time in it.
    let started = Instant::now();
    let mut graphics = 0usize;
    loop {
        let (action, frame) = framed.read_pdu().context("read active RDP frame")?;
        eprintln!(
            "[{:>6}ms] active frame action={action:?} bytes={} prefix={}",
            started.elapsed().as_millis(),
            frame.len(),
            hex_prefix(&frame)
        );
        let outputs = stage
            .process(&mut image, action, &frame)
            .context("process active RDP frame")?;
        for output in outputs {
            match output {
                ActiveStageOutput::ResponseFrame(frame) => {
                    eprintln!(
                        "[{:>6}ms] active response bytes={} prefix={}",
                        started.elapsed().as_millis(),
                        frame.len(),
                        hex_prefix(&frame)
                    );
                    framed.write_all(&frame)?;
                }
                ActiveStageOutput::Terminate(reason) => {
                    return Err(anyhow::anyhow!("server terminated session: {reason}"))
                }
                ActiveStageOutput::GraphicsUpdate(_) => {
                    graphics += 1;
                    if graphics == 1 {
                        eprintln!(
                            "[{:>6}ms] first graphics update: the session is drawing",
                            started.elapsed().as_millis()
                        );
                    }
                }
                // Nothing else is acted on yet, but silence here is what let a
                // whole evening go by without knowing what the server asked for.
                ActiveStageOutput::DeactivateAll => eprintln!(
                    "[{:>6}ms] server asked for deactivation-reactivation",
                    started.elapsed().as_millis()
                ),
                other => eprintln!(
                    "[{:>6}ms] active output not acted on: {}",
                    started.elapsed().as_millis(),
                    output_name(&other)
                ),
            }
        }
    }
}

fn output_name(output: &ActiveStageOutput) -> &'static str {
    match output {
        ActiveStageOutput::ResponseFrame(_) => "ResponseFrame",
        ActiveStageOutput::GraphicsUpdate(_) => "GraphicsUpdate",
        ActiveStageOutput::PointerDefault => "PointerDefault",
        ActiveStageOutput::PointerHidden => "PointerHidden",
        ActiveStageOutput::PointerPosition { .. } => "PointerPosition",
        ActiveStageOutput::PointerBitmap(_) => "PointerBitmap",
        ActiveStageOutput::Terminate(_) => "Terminate",
        ActiveStageOutput::DeactivateAll => "DeactivateAll",
        ActiveStageOutput::MultitransportRequest(_) => "MultitransportRequest",
        _ => "other",
    }
}

/// Rewrites an X.224 Connection Request so it carries only the RDP negotiation
/// request, as the working client does.
///
/// IronRDP adds `Cookie: mstshash=<username>` whenever the credentials name a
/// user, and offers no way to turn it off. A capture of a shadow session that
/// works shows mstsc sending a bare 19-byte request to the same listener, so
/// the cookie is the one thing this client puts on the wire that the reference
/// does not. Returns `None` when there is nothing to strip.
fn x224_request_without_cookie(request: &[u8]) -> Option<Vec<u8>> {
    const BARE: usize = 19;

    if request.len() <= BARE || request[0] != 3 || request[1] != 0 {
        return None;
    }
    if usize::from(u16::from_be_bytes([request[2], request[3]])) != request.len() {
        return None;
    }
    // X.224 Connection Request, and a negotiation request at the very end.
    if request[5] != 0xe0 {
        return None;
    }
    let negotiation = &request[request.len() - 8..];
    if negotiation[0] != 0x01 || u16::from_le_bytes([negotiation[2], negotiation[3]]) != 8 {
        return None;
    }

    let mut bare = Vec::with_capacity(BARE);
    bare.extend_from_slice(&[0x03, 0x00, 0x00, BARE as u8]);
    // Length indicator counts everything after itself.
    bare.extend_from_slice(&[0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00]);
    bare.extend_from_slice(negotiation);
    Some(bare)
}

type TlsStream = rustls::StreamOwned<rustls::ClientConnection, TcpStream>;

/// Byte offset of `earlyCapabilityFlags` from the start of a TS_UD_CS_CORE
/// block: four bytes of header, then the fixed fields ahead of it.
const EARLY_CAPABILITY_FLAGS_AT: usize = 4 + 140;
/// RNS_UD_CS_SUPPORT_DYNVC_GFX_PROTOCOL.
const SUPPORT_DYNVC_GFX_PROTOCOL: u16 = 0x0100;

/// Announces the graphics pipeline in the client core data of an MCS Connect
/// Initial, returning the amended message.
///
/// A shadow listener hands its picture over [MS-RDPEGFX] and has no legacy path
/// to fall back to — the client-side RDP log records `0xA0600` for every session
/// that works. A client is asked about it exactly once, through this flag in
/// TS_UD_CS_CORE, and IronRDP's connector never sets it: registering a handler
/// for the channel is invisible to the server, because dynamic channels are
/// created by the server and the client's handlers are never advertised.
///
/// Returns `None` when there is no client core data here, or when the flag is
/// already set.
fn advertise_graphics_pipeline(message: &[u8]) -> Option<Vec<u8>> {
    let mut at = 0;
    while at + 4 <= message.len() {
        // TS_UD_CS_CORE, little-endian type 0xC001 followed by its length.
        if message[at] != 0x01 || message[at + 1] != 0xc0 {
            at += 1;
            continue;
        }
        let length = usize::from(u16::from_le_bytes([message[at + 2], message[at + 3]]));
        let flags_at = at + EARLY_CAPABILITY_FLAGS_AT;
        if length < EARLY_CAPABILITY_FLAGS_AT + 2
            || at + length > message.len()
            || flags_at + 2 > message.len()
        {
            at += 1;
            continue;
        }

        let flags = u16::from_le_bytes([message[flags_at], message[flags_at + 1]]);
        if flags & SUPPORT_DYNVC_GFX_PROTOCOL != 0 {
            return None;
        }
        let mut amended = message.to_vec();
        amended[flags_at..flags_at + 2]
            .copy_from_slice(&(flags | SUPPORT_DYNVC_GFX_PROTOCOL).to_le_bytes());
        return Some(amended);
    }
    None
}

/// Carries the connection sequence with the graphics pipeline announced.
struct GraphicsPipelineAnnounced {
    inner: TlsStream,
    announced: bool,
}

impl GraphicsPipelineAnnounced {
    fn new(inner: TlsStream) -> Self {
        Self {
            inner,
            announced: false,
        }
    }

    fn socket(&self) -> &TcpStream {
        &self.inner.sock
    }
}

impl Read for GraphicsPipelineAnnounced {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Write for GraphicsPipelineAnnounced {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if !self.announced {
            if let Some(amended) = advertise_graphics_pipeline(buf) {
                self.announced = true;
                eprintln!("client core data now announces the graphics pipeline");
                self.inner.write_all(&amended)?;
                return Ok(buf.len());
            }
        }
        self.inner.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Carries the X.224 exchange, optionally with the cookie removed from the first
/// request. An ordinary RDP server expects the cookie, so it is only stripped
/// for a Remote Assistance listener.
struct BareNegotiation<S> {
    inner: S,
    strip: bool,
    negotiated: bool,
}

impl<S> BareNegotiation<S> {
    fn new(inner: S, strip: bool) -> Self {
        Self {
            inner,
            strip,
            negotiated: false,
        }
    }

    fn into_inner(self) -> S {
        self.inner
    }
}

impl<S: Read> Read for BareNegotiation<S> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf)
    }
}

impl<S: Write> Write for BareNegotiation<S> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.strip && !self.negotiated {
            self.negotiated = true;
            if let Some(bare) = x224_request_without_cookie(buf) {
                eprintln!(
                    "x224 connection request sent without its cookie: {} bytes instead of {}",
                    bare.len(),
                    buf.len()
                );
                self.inner.write_all(&bare)?;
                // The caller's whole request was accounted for, in a shorter form.
                return Ok(buf.len());
            }
        }
        self.inner.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn hex_prefix(bytes: &[u8]) -> String {
    bytes
        .iter()
        .take(96)
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join("")
}

/// The three fields Remote Assistance redefines, and the security to reach them
/// with. Held together so the modes can be compared one against another rather
/// than reasoned about from the specification alone.
struct ClientInfoFields {
    work_dir: String,
    alternate_shell: String,
    password: String,
    credssp: bool,
}

impl ClientInfoFields {
    /// What [MS-RA] section 2.2.7.2 prescribes: the auth string identifier in
    /// **WorkingDir**, `*` in **AlternateShell** because a shadow invitation has
    /// no password, and `*` in **Password**.
    fn remote_assistance(auth_string_id: &str) -> Self {
        Self {
            work_dir: auth_string_id.to_owned(),
            alternate_shell: "*".to_owned(),
            password: "*".to_owned(),
            credssp: false,
        }
    }

    /// The same connection with all three fields left empty. The listener never
    /// performs a logon, so this is a control: if it fails too, the contents of
    /// the Client Info PDU are not what the listener objects to.
    fn bare() -> Self {
        Self {
            work_dir: String::new(),
            alternate_shell: String::new(),
            password: String::new(),
            credssp: false,
        }
    }

    /// An ordinary RDP logon, which fills none of that in and authenticates for
    /// real. This is the control that says whether the client works at all.
    fn logon(password: &str) -> Self {
        Self {
            work_dir: String::new(),
            alternate_shell: String::new(),
            password: password.to_owned(),
            credssp: true,
        }
    }
}

fn build_config(username: &str, info: &ClientInfoFields) -> Config {
    Config {
        credentials: Credentials::UsernamePassword {
            username: username.to_owned(),
            password: info.password.clone(),
        },
        domain: None,
        desktop_size: DesktopSize {
            width: 1280,
            height: 720,
        },
        desktop_scale_factor: 0,
        enable_tls: true,
        // The listener authenticates through the invitation, not a logon, so
        // CredSSP has nothing to offer it. An ordinary server usually demands
        // it: this host has UserAuthentication set.
        enable_credssp: info.credssp,
        client_build: 0,
        client_name: "terminaldeck-shadow".to_owned(),
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0,
        ime_file_name: String::new(),
        bitmap: None,
        dig_product_id: String::new(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        alternate_shell: info.alternate_shell.clone(),
        work_dir: info.work_dir.clone(),
        platform: MajorPlatformType::WINDOWS,
        hardware_id: None,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        compression_type: Some(CompressionType::Rdp61),
        pointer_software_rendering: true,
        enable_server_pointer: false,
        multitransport_flags: None,
        performance_flags: PerformanceFlags::default(),
        timezone_info: TimezoneInfo::default(),
        license_cache: None,
    }
}

fn tls_upgrade(
    stream: TcpStream,
    host: &str,
) -> Result<(
    rustls::StreamOwned<rustls::ClientConnection, TcpStream>,
    Vec<u8>,
)> {
    let mut config = rustls::client::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoCertificateVerification))
        .with_no_client_auth();
    config.resumption = rustls::client::Resumption::disabled();
    let server_name = host.to_owned().try_into()?;
    let client = rustls::ClientConnection::new(Arc::new(config), server_name)?;
    let mut tls = rustls::StreamOwned::new(client, stream);
    tls.flush()?;
    let certificate = tls
        .conn
        .peer_certificates()
        .and_then(|list| list.first())
        .context("server certificate missing")?;
    let parsed = x509_cert::Certificate::from_der(certificate.as_ref())
        .context("parse server certificate")?;
    let public_key = parsed
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .context("server public key missing")?
        .to_vec();
    Ok((tls, public_key))
}

#[derive(Debug)]
struct NoCertificateVerification;

impl rustls::client::danger::ServerCertVerifier for NoCertificateVerification {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _: &[u8],
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        vec![
            rustls::SignatureScheme::RSA_PKCS1_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message_types(packets: &[Vec<u8>]) -> Vec<u32> {
        packets
            .iter()
            .map(|packet| {
                parse_remote_assistance_packet(packet)
                    .expect("built packet parses")
                    .0
            })
            .collect()
    }

    #[test]
    fn a_control_packet_matches_the_wire_layout() {
        // ChannelNameLen=14, DataLength=4 (the message type alone), the channel
        // name "RC_CTL" as null-terminated UTF-16LE, then EXPERT_ON_VISTA.
        assert_eq!(
            hex_prefix(&build_remote_assistance_packet(9, &[])),
            "0e00000004000000520043005f00430054004c00000009000000"
        );
    }

    #[test]
    fn a_built_packet_parses_back() {
        let blob = utf16le_null_terminated(&expert_blob("a", ""));
        let packet = build_remote_assistance_packet(8, &blob);
        let (message_type, body) = parse_remote_assistance_packet(&packet).expect("valid packet");
        assert_eq!(message_type, 8);
        assert_eq!(body, blob.as_slice());
    }

    #[test]
    fn the_expert_blob_counts_both_segments() {
        assert_eq!(expert_blob("Admin", ""), "10;NAME=Admin5;PASS=");
        assert_eq!(expert_blob("Admin", "ab"), "10;NAME=Admin7;PASS=ab");
    }

    #[test]
    fn each_opening_message_from_the_novice_draws_its_own_reply() {
        let mut vista = false;
        let mut verify = false;

        // VERSIONINFO is dropped; sending EXPERT_ON_VISTA is what selects v2.
        let version = [1u32.to_le_bytes(), 2u32.to_le_bytes()].concat();
        let answered =
            remote_assistance_control_responses(6, &version, "Admin", &mut vista, &mut verify);
        assert_eq!(message_types(&answered), vec![9]);

        // VERIFY_PASSWORD answers SERVER_ANNOUNCE, not the version.
        let announced =
            remote_assistance_control_responses(4, &[], "Admin", &mut vista, &mut verify);
        assert_eq!(message_types(&announced), vec![8]);

        assert!(vista && verify);
    }

    #[test]
    fn neither_reply_is_sent_twice() {
        let version = [1u32.to_le_bytes(), 2u32.to_le_bytes()].concat();
        let mut vista = true;
        let mut verify = true;
        assert!(
            remote_assistance_control_responses(6, &version, "Admin", &mut vista, &mut verify)
                .is_empty()
        );
        assert!(
            remote_assistance_control_responses(4, &[], "Admin", &mut vista, &mut verify).is_empty()
        );
    }

    #[test]
    fn a_cookie_is_stripped_from_the_connection_request() {
        // Both captured from the same listener: what this client sent, and what
        // mstsc sent in a session that worked.
        let ours = "0300002e29e00000000000436f6f6b69653a206d737473686173683d61646d696e7264700d0a0100080001000000";
        let mstsc = "030000130ee000000000000100080001000000";
        let bytes: Vec<u8> = (0..ours.len() / 2)
            .map(|i| u8::from_str_radix(&ours[i * 2..i * 2 + 2], 16).unwrap())
            .collect();

        let bare = x224_request_without_cookie(&bytes).expect("a cookie to strip");
        assert_eq!(hex_prefix(&bare), mstsc);
    }

    #[test]
    fn a_request_that_carries_no_cookie_is_left_alone() {
        let bare: Vec<u8> = vec![
            0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08,
            0x00, 0x01, 0x00, 0x00, 0x00,
        ];
        assert!(x224_request_without_cookie(&bare).is_none());
        // Nor is anything else on the connection touched.
        assert!(x224_request_without_cookie(&[0x17, 0x03, 0x03, 0x00, 0x40]).is_none());
    }

    /// A TS_UD_CS_CORE block long enough to carry earlyCapabilityFlags, with
    /// the flags IronRDP actually sets.
    fn client_core_data(flags: u16) -> Vec<u8> {
        let length = EARLY_CAPABILITY_FLAGS_AT + 2 + 70;
        let mut block = vec![0u8; length];
        block[0..2].copy_from_slice(&0xc001u16.to_le_bytes());
        block[2..4].copy_from_slice(&(length as u16).to_le_bytes());
        block[EARLY_CAPABILITY_FLAGS_AT..EARLY_CAPABILITY_FLAGS_AT + 2]
            .copy_from_slice(&flags.to_le_bytes());
        block
    }

    fn flags_of(message: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([
            message[at + EARLY_CAPABILITY_FLAGS_AT],
            message[at + EARLY_CAPABILITY_FLAGS_AT + 1],
        ])
    }

    #[test]
    fn the_graphics_pipeline_is_announced_without_disturbing_other_flags() {
        // What the connector sets: valid connection type, error info, strong
        // keys, autodetect, skip channel join.
        let existing = 0x0020 | 0x0001 | 0x0008 | 0x0080 | 0x0800;
        let mut message = vec![0xde, 0xad, 0xbe, 0xef];
        let block_at = message.len();
        message.extend_from_slice(&client_core_data(existing));

        let amended = advertise_graphics_pipeline(&message).expect("a block to amend");
        assert_eq!(amended.len(), message.len());
        assert_eq!(&amended[..block_at], &message[..block_at]);
        assert_eq!(
            flags_of(&amended, block_at),
            existing | SUPPORT_DYNVC_GFX_PROTOCOL
        );
    }

    #[test]
    fn a_message_that_needs_no_change_is_left_alone() {
        // Already announced.
        let mut message = client_core_data(SUPPORT_DYNVC_GFX_PROTOCOL);
        assert!(advertise_graphics_pipeline(&message).is_none());

        // Not client core data at all, and too short to be mistaken for it.
        message = vec![0x01, 0xc0, 0x10, 0x00, 0x00, 0x00];
        assert!(advertise_graphics_pipeline(&message).is_none());
    }

    #[test]
    fn the_auth_string_id_comes_from_the_auth_string_node() {
        let invitation = "<E><A KH=\"hash\" KH2=\"sha256:hash\" ID=\"AUTHSTRING\" CE=\"cert\"/>\
                          <C><T ID=\"1\" SID=\"1440550163\"><L P=\"51825\" N=\"10.0.0.1\"/></T></C></E>";
        // Not the transport node's ID, and not the tail of its SID.
        assert_eq!(auth_string_id(invitation).as_deref(), Some("AUTHSTRING"));
    }

    #[test]
    fn an_invitation_without_an_auth_string_node_has_no_id() {
        assert_eq!(auth_string_id("<E><C><T ID=\"1\"/></C></E>"), None);
    }

    #[test]
    fn the_control_channel_is_named_by_the_specification() {
        // [MS-RA] 3.5.3 names RC_CTL; remdesk is FreeRDP's name for it and is
        // registered alongside only until a live session settles which one the
        // novice speaks on.
        assert_eq!(
            RemoteAssistanceControl::new(Arc::new(Mutex::new(Vec::new())), "a".to_owned())
                .channel_name(),
            ChannelName::from_utf8("RC_CTL").unwrap()
        );
        assert_eq!(
            RemoteAssistanceControlRemdesk::new(Arc::new(Mutex::new(Vec::new())), "a".to_owned())
                .channel_name(),
            ChannelName::from_utf8("remdesk").unwrap()
        );
    }
}
