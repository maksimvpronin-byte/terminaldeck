use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use ironrdp_connector::{ClientConnector, Config, ConnectionResult, Credentials, DesktopSize};
use ironrdp_core::{impl_as_any, Encode, EncodeResult, WriteCursor};
use ironrdp_dvc::{DrdynvcClient, DvcMessage, DvcProcessor};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_pdu::gcc::{ChannelName, KeyboardType};
use ironrdp_pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp_pdu::rdp::client_info::{CompressionType, PerformanceFlags, TimezoneInfo};
use ironrdp_pdu::PduResult;
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStageBuilder, ActiveStageOutput};
use ironrdp_svc::{
    CompressionCondition, StaticChannelSet, StaticVirtualChannel, SvcClientProcessor, SvcMessage,
    SvcProcessor, SvcProcessorMessages,
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

#[derive(Debug, Clone)]
struct RemoteAssistanceControl {
    trace: Trace,
    expert_name: String,
    setup_sent: bool,
}

impl_as_any!(RemoteAssistanceControl);

impl SvcProcessor for RemoteAssistanceControl {
    fn channel_name(&self) -> ChannelName {
        ChannelName::from_utf8("remdesk").expect("valid RDP channel name")
    }

    fn compression_condition(&self) -> CompressionCondition {
        CompressionCondition::Never
    }

    fn process(&mut self, payload: &[u8]) -> PduResult<Vec<SvcMessage>> {
        eprintln!(
            "svc remdesk data bytes={} prefix={}",
            payload.len(),
            hex_prefix(payload)
        );
        if let Ok(mut trace) = self.trace.lock() {
            if trace.len() < 16 {
                trace.push(("remdesk".to_owned(), payload.to_vec()));
            }
        }

        let Some((message_type, body)) = parse_remote_assistance_packet(payload) else {
            eprintln!("svc remdesk data is not a valid Remote Assistance packet");
            return Ok(Vec::new());
        };
        eprintln!(
            "svc remdesk RC_CTL msgType={} ({}) bodyBytes={}",
            message_type,
            remote_assistance_message_name(message_type),
            body.len()
        );

        let responses = remote_assistance_control_responses(
            message_type,
            body,
            &self.expert_name,
            &mut self.setup_sent,
        );
        Ok(responses.into_iter().map(SvcMessage::from).collect())
    }
}

impl SvcClientProcessor for RemoteAssistanceControl {}

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

fn main() -> io::Result<()> {
    // Keep the first native milestone deterministic and dependency-light: read
    // stdin so the helper can be supervised by Electron, and expose the fact
    // that the remdesk processor is compiled into this binary.
    let trace = Arc::new(Mutex::new(Vec::new()));
    let channel = StaticVirtualChannel::new(RemoteAssistanceControl {
        trace: trace.clone(),
        expert_name: "Expert".to_owned(),
        setup_sent: false,
    });
    assert_eq!(
        channel.channel_name(),
        ChannelName::from_utf8("remdesk").unwrap()
    );

    let config = Config {
        credentials: Credentials::UsernamePassword {
            username: "remote-assistance".to_owned(),
            password: String::new(),
        },
        domain: None,
        desktop_size: DesktopSize {
            width: 1280,
            height: 720,
        },
        desktop_scale_factor: 0,
        // The RpcShadow2 listener is a Remote Assistance endpoint, not a
        // normal interactive RDP logon. The invitation is authenticated later
        // on RC_CTL, so do not start CredSSP/NLA here.
        enable_tls: true,
        enable_credssp: false,
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
        alternate_shell: String::new(),
        work_dir: String::new(),
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
    };
    let connector = ClientConnector::new(config, SocketAddr::from(([127, 0, 0, 1], 0)))
        .with_static_channel(RemoteAssistanceControl {
            trace: trace.clone(),
            expert_name: "Expert".to_owned(),
            setup_sent: false,
        })
        .with_static_channel(DrdynvcClient::new().with_dynamic_channel(RdpEchoDynamic {
            trace: trace.clone(),
        }))
        .with_static_channel(RemoteAssistanceChat {
            trace: trace.clone(),
        })
        .with_static_channel(RemoteAssistanceShare {
            trace: trace.clone(),
        })
        .with_static_channel(RemoteAssistanceMultiparty {
            trace: trace.clone(),
        });
    assert!(connector
        .static_channels
        .get_by_channel_name(&ChannelName::from_utf8("remdesk").unwrap())
        .is_some());

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
            connect_once(
                &args[1],
                args[2].parse().unwrap_or(3389),
                &args[3],
                invitation.as_deref(),
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

/// The expert's side of the control exchange.
///
/// The novice drives it with a single VERSIONINFO, and everything the expert
/// has to say for protocol v2 goes out in reply to that one message. Nothing
/// may be gated on SERVER_ANNOUNCE: it carries no expert response, and a novice
/// that never sends one would leave the handshake waiting forever.
fn remote_assistance_control_responses(
    message_type: u32,
    body: &[u8],
    expert_name: &str,
    setup_sent: &mut bool,
) -> Vec<Vec<u8>> {
    match message_type {
        2 => {
            match read_u32(body) {
                Some(0) => eprintln!("remote assistance RESULT ok"),
                Some(code) => eprintln!("remote assistance RESULT error 0x{code:08x}"),
                None => eprintln!("remote assistance RESULT is truncated"),
            }
            Vec::new()
        }
        6 => {
            let Some((major, minor)) = read_version(body) else {
                eprintln!("remote assistance VERSIONINFO is truncated");
                return Vec::new();
            };
            eprintln!("remote assistance novice announced protocol {major}.{minor}");
            if *setup_sent {
                return Vec::new();
            }
            // The negotiated version is the novice's minor number.
            if major != 1 || minor != 2 {
                eprintln!(
                    "remote assistance protocol {major}.{minor} needs the AUTHENTICATE and \
                     REMOTE_CONTROL_DESKTOP exchange, which this helper does not implement"
                );
                return Vec::new();
            }
            *setup_sent = true;
            remote_assistance_expert_opening(expert_name)
        }
        _ => Vec::new(),
    }
}

/// What the expert says to open the exchange.
///
/// The novice does not announce a version and wait to be answered: it picks the
/// protocol version from what it *receives*, and EXPERT_ON_VISTA is the message
/// that selects version 2. An expert that waits to be spoken to first leaves
/// both sides silent until the listener gives up on the connection.
fn remote_assistance_expert_opening(expert_name: &str) -> Vec<Vec<u8>> {
    eprintln!("remote assistance sending EXPERT_ON_VISTA and VERIFY_PASSWORD");
    vec![
        // A shadow invitation carries no PassStub, so there is no password to
        // encrypt into this message's body.
        build_remote_assistance_packet(9, &[]),
        build_remote_assistance_packet(8, &utf16le_null_terminated(&expert_blob(expert_name, ""))),
    ]
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
) -> Result<(u16, Trace)> {
    let address = (host, port)
        .to_socket_addrs()
        .context("resolve Remote Assistance endpoint")?
        .next()
        .context("endpoint has no address")?;
    let stream = TcpStream::connect_timeout(&address, Duration::from_secs(15))?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let local = stream.local_addr()?;
    let mut framed = ironrdp_blocking::Framed::new(BareNegotiation::new(stream));
    let trace: Trace = Arc::new(Mutex::new(Vec::new()));

    let auth_string = invitation.and_then(auth_string_id);
    match &auth_string {
        Some(id) => eprintln!(
            "remote assistance invitation loaded bytes={} auth string id={id}",
            invitation.map_or(0, str::len)
        ),
        None => eprintln!(
            "remote assistance invitation has no auth string id: the novice has \
             nothing to match this connection against and will drop it"
        ),
    }
    let config = build_config(username, auth_string.as_deref().unwrap_or_default());
    let expert_name = username.rsplit('\\').next().unwrap_or(username).to_owned();
    let mut connector = ClientConnector::new(config, local)
        .with_static_channel(RemoteAssistanceControl {
            trace: trace.clone(),
            expert_name: expert_name.clone(),
            setup_sent: false,
        })
        .with_static_channel(DrdynvcClient::new().with_dynamic_channel(RdpEchoDynamic {
            trace: trace.clone(),
        }))
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
    let mut upgraded = ironrdp_blocking::Framed::new(tls_stream);
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
    if let Err(error) = run_active_stage(result, &expert_name, upgraded) {
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
    expert_name: &str,
    mut framed: ironrdp_blocking::Framed<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>,
) -> Result<()> {
    log_granted_channels(&result.static_channels);
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

    let opening: Vec<SvcMessage> = remote_assistance_expert_opening(expert_name)
        .into_iter()
        .map(SvcMessage::from)
        .collect();
    let frame = stage
        .process_svc_processor_messages(SvcProcessorMessages::<RemoteAssistanceControl>::new(
            opening,
        ))
        .context("encode the expert's opening remdesk messages")?;
    framed.write_all(&frame)?;
    // The reactive path must not repeat what has just gone out.
    if let Some(control) = stage.get_svc_processor_mut::<RemoteAssistanceControl>() {
        control.setup_sent = true;
    }

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

/// Carries the X.224 exchange with the cookie removed from the first request.
struct BareNegotiation<S> {
    inner: S,
    negotiated: bool,
}

impl<S> BareNegotiation<S> {
    fn new(inner: S) -> Self {
        Self {
            inner,
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
        if !self.negotiated {
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

/// Remote Assistance replaces four fields of the ordinary Client Info PDU
/// ([MS-RA] section 2.2.7.2): the auth string identifier goes in **WorkingDir**,
/// **AlternateShell** holds the invitation's password or `*` when it has none,
/// and **Password** is always `*`. The identifier is how the novice recognises
/// which invitation this connection is answering; without it the connection
/// completes and is then dropped.
fn build_config(username: &str, auth_string_id: &str) -> Config {
    Config {
        credentials: Credentials::UsernamePassword {
            username: username.to_owned(),
            password: "*".to_owned(),
        },
        domain: None,
        desktop_size: DesktopSize {
            width: 1280,
            height: 720,
        },
        desktop_scale_factor: 0,
        enable_tls: true,
        enable_credssp: false,
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
        // A shadow invitation is never password protected.
        alternate_shell: "*".to_owned(),
        work_dir: auth_string_id.to_owned(),
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
    fn version_info_carries_the_whole_expert_setup() {
        let body = [1u32.to_le_bytes(), 2u32.to_le_bytes()].concat();
        let mut setup_sent = false;

        let responses = remote_assistance_control_responses(6, &body, "Admin", &mut setup_sent);
        assert_eq!(message_types(&responses), vec![9, 8]);
        assert!(setup_sent);

        // A repeated announcement must not restart the exchange.
        let repeat = remote_assistance_control_responses(6, &body, "Admin", &mut setup_sent);
        assert!(repeat.is_empty());
    }

    #[test]
    fn a_version_the_helper_cannot_speak_sends_nothing() {
        let body = [1u32.to_le_bytes(), 1u32.to_le_bytes()].concat();
        let mut setup_sent = false;
        assert!(remote_assistance_control_responses(6, &body, "Admin", &mut setup_sent).is_empty());
        assert!(!setup_sent);
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
    fn server_announce_never_holds_up_the_handshake() {
        let mut setup_sent = false;
        assert!(remote_assistance_control_responses(4, &[], "Admin", &mut setup_sent).is_empty());
        assert!(!setup_sent);
    }
}
